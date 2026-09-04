import { readdir } from 'node:fs/promises';
import { extname, join, parse } from 'node:path';
import { env } from '../../config/env.ts';
import { emptyManifest, loadManifest, type ManifestLookup } from '../manifest.ts';
import type { SourceItem, VideoSource } from '../types.ts';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm']);

/**
 * The corpus the demo runs on: a local directory of videos.
 *
 * Deliberately the primary source. A live scraper would make the demo depend on a
 * third-party site being reachable, unblocked and logged in at the moment of the
 * presentation, which is a risk with no upside - the assignment explicitly allows
 * content from any source.
 *
 * Creator attribution comes from an optional manifest (see ../manifest.ts). Without
 * one, every item ingests with null creator fields, which the rest of the system
 * handles: such videos are exempt from the per-creator diversity cap and contribute
 * nothing to creator affinity.
 */
export class DemoVideoSource implements VideoSource {
  readonly name = 'demo';

  private manifest: ManifestLookup = emptyManifest();
  private unmatchedManifestFiles: string[] = [];

  constructor(
    private readonly directory: string = env.DEMO_SOURCE_DIR,
    private readonly manifestPath: string = env.DEMO_MANIFEST_PATH,
  ) {}

  async *discover(limit: number): AsyncIterable<SourceItem> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot read demo source directory "${this.directory}": ${message}\n` +
          `Put 20-30 videos there, or set DEMO_SOURCE_DIR.`,
        { cause: error },
      );
    }

    // A malformed manifest throws; a missing one is normal.
    this.manifest = await loadManifest(this.manifestPath);

    // Ordered by raw code unit, not localeCompare: locale collation ignores
    // punctuation (so "a_copy.mp4" can sort before "a.mp4") and depends on the
    // machine's ICU data. When two files share content, discovery order decides
    // which one owns the row, so that order must be identical everywhere.
    const files = entries
      .filter((name) => VIDEO_EXTENSIONS.has(extname(name).toLowerCase()))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    // Computed against the whole directory, not the limited slice, so --limit does
    // not make unrelated manifest lines look stale.
    this.unmatchedManifestFiles = this.manifest.unmatched(files);

    for (const name of files.slice(0, limit)) {
      const attribution = this.manifest.get(name);
      yield {
        externalId: parse(name).name,
        fileName: name,
        localPath: join(this.directory, name),
        pageUrl: null,
        creatorId: attribution.creatorId,
        creatorHandle: attribution.creatorHandle,
      };
    }
  }

  warnings(): string[] {
    return this.unmatchedManifestFiles.map(
      (file) => `manifest lists "${file}", which is not in ${this.directory}`,
    );
  }
}
