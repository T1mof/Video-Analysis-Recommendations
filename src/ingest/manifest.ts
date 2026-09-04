import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Optional creator attribution for the local corpus.
 *
 * Local files carry no creator metadata, but creator affinity (ranking) and the
 * per-creator diversity cap only become demonstrable if at least some videos have
 * a creator. The manifest is the seam that lets the demo corpus exercise those
 * paths without inventing a scraper.
 *
 * Entirely optional: no file means every video ingests with null creator fields,
 * which is a supported state everywhere downstream.
 */

const manifestEntrySchema = z.object({
  file: z.string().min(1),
  creatorId: z.string().min(1).nullish(),
  creatorHandle: z.string().min(1).nullish(),
});

export const manifestSchema = z.array(manifestEntrySchema);

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export interface ManifestLookup {
  /** Attribution by exact filename, e.g. "video_01.mp4". */
  get(filename: string): { creatorId: string | null; creatorHandle: string | null };
  /** Manifest filenames that matched nothing in the source directory. */
  unmatched(presentFilenames: readonly string[]): string[];
  readonly size: number;
  readonly present: boolean;
}

export class ManifestError extends Error {}

const EMPTY: ManifestLookup = {
  get: () => ({ creatorId: null, creatorHandle: null }),
  unmatched: () => [],
  size: 0,
  present: false,
};

export function emptyManifest(): ManifestLookup {
  return EMPTY;
}

function buildLookup(entries: ManifestEntry[]): ManifestLookup {
  const byFile = new Map<string, ManifestEntry>();
  for (const entry of entries) byFile.set(entry.file, entry);

  return {
    get(filename) {
      const entry = byFile.get(filename);
      return {
        creatorId: entry?.creatorId ?? null,
        creatorHandle: entry?.creatorHandle ?? null,
      };
    },
    unmatched(presentFilenames) {
      const present = new Set(presentFilenames);
      return [...byFile.keys()].filter((file) => !present.has(file)).sort();
    },
    size: byFile.size,
    present: true,
  };
}

/**
 * Reads and validates the manifest.
 *
 * A missing file is normal and returns an empty lookup. A file that exists but is
 * malformed is an error: someone wrote it intending it to be used, so silently
 * ignoring it would hide the mistake behind a corpus with no creators.
 */
export async function loadManifest(path: string): Promise<ManifestLookup> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw new ManifestError(
      `Cannot read manifest "${path}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ManifestError(
      `Manifest "${path}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n` +
        `Expected: [{ "file": "video_01.mp4", "creatorId": "creator_01", "creatorHandle": "demo_creator_01" }]`,
      { cause: error },
    );
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  [${i.path.join('.')}] ${i.message}`)
      .join('\n');
    throw new ManifestError(
      `Manifest "${path}" does not match the expected shape:\n${issues}\n` +
        `Expected: [{ "file": "video_01.mp4", "creatorId": "creator_01", "creatorHandle": "demo_creator_01" }]`,
    );
  }

  const duplicates = result.data
    .map((e) => e.file)
    .filter((file, index, all) => all.indexOf(file) !== index);
  if (duplicates.length > 0) {
    throw new ManifestError(
      `Manifest "${path}" lists the same file more than once: ${[...new Set(duplicates)].join(', ')}`,
    );
  }

  return buildLookup(result.data);
}
