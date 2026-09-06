/**
 * Opaque pagination cursor.
 *
 * Page numbers are wrong for a feed: the list can be rebuilt between requests, so
 * "page 3" would silently mean a different slice of a different generation. A
 * cursor names the exact generation it belongs to, so a session keeps reading the
 * list it started on.
 *
 * The cursor is opaque to clients but is *not* a capability: it is validated
 * against the requesting user before anything is read, so it cannot be used to
 * address another user's feed or to inject an arbitrary Redis key. There is no
 * signing - the project has no secret to sign with, and inventing one for an MVP
 * with no auth would be security theatre. Everything it encodes is already known
 * to the client, so tampering gains nothing that validation does not catch.
 */

export const CURSOR_VERSION = 1;

/** Encoded cursors are ~80 bytes; anything far larger is not ours. */
export const MAX_CURSOR_LENGTH = 512;

export interface FeedCursor {
  version: number;
  userId: string;
  feedId: string;
  offset: number;
}

export class InvalidCursorError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid cursor: ${reason}`);
    this.name = 'InvalidCursorError';
  }
}

export function encodeCursor(cursor: Omit<FeedCursor, 'version'>): string {
  const payload = JSON.stringify({
    v: CURSOR_VERSION,
    u: cursor.userId,
    f: cursor.feedId,
    o: cursor.offset,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Decodes and fully validates a cursor against the user making the request.
 *
 * Length is checked before decoding so a huge payload is rejected rather than
 * parsed. Every field is validated: a cursor that names another user is a client
 * error, not something to be resolved and served.
 */
export function decodeCursor(raw: string, expectedUserId: string): FeedCursor {
  if (raw.length === 0) throw new InvalidCursorError('empty');
  if (raw.length > MAX_CURSOR_LENGTH) throw new InvalidCursorError('too long');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('not decodable');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new InvalidCursorError('not an object');
  }

  const { v, u, f, o } = parsed as Record<string, unknown>;

  if (v !== CURSOR_VERSION) throw new InvalidCursorError('unsupported version');
  if (typeof u !== 'string' || u.length === 0) throw new InvalidCursorError('missing user');
  if (typeof f !== 'string' || f.length === 0) throw new InvalidCursorError('missing feed');
  if (typeof o !== 'number' || !Number.isInteger(o) || o < 0) {
    throw new InvalidCursorError('invalid offset');
  }
  if (u !== expectedUserId) throw new InvalidCursorError('belongs to a different user');

  return { version: v, userId: u, feedId: f, offset: o };
}
