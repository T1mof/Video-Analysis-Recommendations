import { describe, expect, it } from 'vitest';
import {
  CURSOR_VERSION,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  decodeCursor,
  encodeCursor,
} from '../../src/feed/cursor.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FEED = 'feed-abc';

describe('cursor round trip', () => {
  it('preserves feed and offset', () => {
    const encoded = encodeCursor({ userId: USER, feedId: FEED, offset: 20 });
    const decoded = decodeCursor(encoded, USER);

    expect(decoded).toEqual({ version: CURSOR_VERSION, userId: USER, feedId: FEED, offset: 20 });
  });

  it('is opaque rather than a readable offset', () => {
    const encoded = encodeCursor({ userId: USER, feedId: FEED, offset: 20 });
    expect(encoded).not.toContain(FEED);
    expect(encoded).not.toContain('20');
  });

  it('accepts offset zero', () => {
    const encoded = encodeCursor({ userId: USER, feedId: FEED, offset: 0 });
    expect(decodeCursor(encoded, USER).offset).toBe(0);
  });
});

describe('cursor validation', () => {
  it('rejects a cursor issued for another user', () => {
    const encoded = encodeCursor({ userId: OTHER, feedId: FEED, offset: 0 });
    expect(() => decodeCursor(encoded, USER)).toThrow(InvalidCursorError);
  });

  it('rejects an unsupported version', () => {
    const forged = Buffer.from(JSON.stringify({ v: 99, u: USER, f: FEED, o: 0 })).toString(
      'base64url',
    );
    expect(() => decodeCursor(forged, USER)).toThrow(/version/);
  });

  it('rejects a negative or fractional offset', () => {
    for (const offset of [-1, 1.5]) {
      const forged = Buffer.from(JSON.stringify({ v: 1, u: USER, f: FEED, o: offset })).toString(
        'base64url',
      );
      expect(() => decodeCursor(forged, USER)).toThrow(/offset/);
    }
  });

  it('rejects a missing feed id, which would otherwise address an unknown key', () => {
    const forged = Buffer.from(JSON.stringify({ v: 1, u: USER, o: 0 })).toString('base64url');
    expect(() => decodeCursor(forged, USER)).toThrow(/feed/);
  });

  it('rejects malformed and empty input', () => {
    expect(() => decodeCursor('', USER)).toThrow(InvalidCursorError);
    expect(() => decodeCursor('not-base64!!', USER)).toThrow(InvalidCursorError);
    expect(() => decodeCursor(Buffer.from('[]').toString('base64url'), USER)).toThrow(
      InvalidCursorError,
    );
  });

  it('rejects an oversized cursor before attempting to decode it', () => {
    const huge = 'a'.repeat(MAX_CURSOR_LENGTH + 1);
    expect(() => decodeCursor(huge, USER)).toThrow(/too long/);
  });

  it('does not let a cursor smuggle a key into the feed id', () => {
    // Even a hostile feed id stays scoped: the cache builds its key from the
    // authenticated userId plus this value, and a lookup simply misses.
    const encoded = encodeCursor({ userId: USER, feedId: '*', offset: 0 });
    expect(decodeCursor(encoded, USER).feedId).toBe('*');
  });
});
