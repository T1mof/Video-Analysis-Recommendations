import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SampledFrame } from './preprocess.ts';

const execFileAsync = promisify(execFile);

/**
 * ffmpeg's drawtext needs an explicit font on Windows: the Gyan builds ship
 * without a fontconfig database, so drawtext fails with "Cannot load default
 * config file" unless a fontfile is named outright.
 */
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
];

let cachedFont: string | null | undefined;

async function findFont(): Promise<string | null> {
  if (cachedFont !== undefined) return cachedFont;

  for (const candidate of FONT_CANDIDATES) {
    try {
      await access(candidate);
      cachedFont = candidate;
      return cachedFont;
    } catch {
      // try the next one
    }
  }

  cachedFont = null;
  return cachedFont;
}

/** Escapes a path for use inside an ffmpeg filtergraph option value. */
function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/**
 * Debug artefact only - never part of the production pipeline.
 *
 * Tiles the selected frames into one image with each timestamp burned underneath,
 * so a human can judge in one glance whether the sampler actually represents the
 * video. Reviewing eight separate JPEGs per video across a 30-video corpus is the
 * kind of check that does not get done; a contact sheet is.
 */
export interface ContactSheetOptions {
  /** Width of each cell in the grid. */
  cellWidth?: number;
  columns?: number;
}

export async function buildContactSheet(
  frames: readonly SampledFrame[],
  outputPath: string,
  options: ContactSheetOptions = {},
): Promise<string> {
  if (frames.length === 0) throw new Error('Cannot build a contact sheet from zero frames');

  const cellWidth = options.cellWidth ?? 320;
  const columns = options.columns ?? Math.min(4, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const labelHeight = 30;

  const staging = await mkdtemp(join(tmpdir(), 'contact-sheet-'));
  await mkdir(dirname(outputPath), { recursive: true });
  const font = await findFont();

  try {
    // Every cell must be identical in size for the tile filter. Scaling with
    // force_original_aspect_ratio rounds, and can land a pixel over the target, so
    // the chain pads up to at least the cell box and then crops to exactly it -
    // that pair is exact whichever way the rounding went.
    const cellHeight = Math.round((cellWidth * 16) / 9 / 2) * 2;

    for (const [index, frame] of frames.entries()) {
      const cellPath = join(staging, `cell_${String(index + 1).padStart(3, '0')}.jpg`);
      const label = `${frame.timestampSec.toFixed(2)}s`;

      await execFileAsync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          frame.path,
          '-vf',
          [
            `scale=${cellWidth}:${cellHeight}:force_original_aspect_ratio=decrease`,
            `pad=max(${cellWidth}\\,iw):max(${cellHeight}\\,ih):(ow-iw)/2:(oh-ih)/2:color=black`,
            `crop=${cellWidth}:${cellHeight}:(iw-ow)/2:(ih-oh)/2`,
            `pad=${cellWidth}:${cellHeight + labelHeight}:0:0:color=black`,
            // Without a usable font the sheet is still built, just unlabelled -
            // a debug aid should degrade, not fail.
            ...(font
              ? [
                  `drawtext=fontfile='${escapeFilterPath(font)}':text='${label}'` +
                    `:fontcolor=white:fontsize=20:x=8:y=${cellHeight + 5}`,
                ]
              : []),
          ].join(','),
          '-frames:v',
          '1',
          '-q:v',
          '3',
          '-y',
          cellPath,
        ],
        { maxBuffer: 16 * 1024 * 1024 },
      );
    }

    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-start_number',
        '1',
        '-i',
        join(staging, 'cell_%03d.jpg'),
        '-vf',
        `tile=${columns}x${rows}:padding=4:margin=4:color=#101014`,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-y',
        outputPath,
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    );

    return outputPath;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
