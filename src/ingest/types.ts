/**
 * Ingestion source abstraction.
 *
 * Everything downstream of a source - validation, checksum dedup, object storage,
 * the videos row, enqueueing analysis - is shared and source-agnostic. A source's
 * only job is to yield candidate items; it never touches the database or S3.
 *
 * `DemoVideoSource` (local files) is what the deliverable and the demo run on. A
 * best-effort Fansly/Fanvue scraper is an optional bonus scheduled after the main
 * pipeline is complete, and the demo must never depend on a live third-party site.
 * See docs/PROJECT_CONTEXT.md "Ingestion and content sources".
 */
export interface SourceItem {
  /** Stable id within the source. Used for traceability, not for dedup. */
  externalId: string;
  /** Original filename, carried through so the CLI can print filename -> UUID. */
  fileName?: string;
  /** Local file to ingest. Exactly one of localPath / mediaUrl must be set. */
  localPath?: string;
  /** Remote media URL to download. */
  mediaUrl?: string;
  /** Page the item was found on, for attribution. */
  pageUrl?: string | null;
  /** Both nullable: many sources expose no creator at all. */
  creatorId?: string | null;
  creatorHandle?: string | null;
}

export interface VideoSource {
  readonly name: string;
  /** Yields at most `limit` items. Lazy so a slow source streams rather than batches. */
  discover(limit: number): AsyncIterable<SourceItem>;
  /**
   * Diagnostics gathered during discovery - currently manifest entries naming a
   * file that is not present. Reported rather than thrown: a stale manifest line
   * should not stop a corpus from ingesting.
   */
  warnings?(): string[];
}

/**
 * Why a candidate did not become a video row.
 *
 * Aspect ratio is deliberately absent: a landscape video is still a valid video and
 * is ingested. Portrait-ness is a presentation concern for the feed, not a reason to
 * refuse content at the storage boundary - filtering it at ingestion would throw away
 * material that a later product decision might want.
 */
export type RejectionReason =
  | 'too_long'
  | 'too_short'
  | 'probe_failed'
  | 'download_failed'
  | 'unreadable';

/** Noted on an ingested video without blocking it. */
export type IngestWarning = 'not_vertical' | 'creator_conflict';

export interface IngestOutcome {
  externalId: string;
  /** Source filename, for building the gold dataset mapping. */
  fileName?: string;
  status: 'ingested' | 'duplicate' | 'rejected' | 'failed';
  videoId?: string;
  reason?: RejectionReason;
  warnings?: IngestWarning[];
  /** Creator attribution was backfilled onto an existing row from the manifest. */
  creatorEnriched?: boolean;
  detail?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
}

export interface IngestSummary {
  source: string;
  ingested: number;
  duplicates: number;
  rejected: number;
  failed: number;
  outcomes: IngestOutcome[];
  /** Manifest filenames that matched no file in the source. */
  unmatchedManifestEntries: string[];
}
