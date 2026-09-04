import { describe, it, expect } from 'vitest';
import { compactUrls, parseHttpStatus, isTransientFailure } from '../wacli/failures.js';
import { describeDownloadFailure } from '../routes/media.js';

/**
 * A real WhatsApp media URL, taken from the run log that prompted this work.
 * Its length is the whole point: on its own it is longer than the logger's
 * 240-character per-field cap, so anything Go appended after it was cut.
 */
const MEDIA_URL =
  'https://mmg.whatsapp.net/o1/v/t24/f2/m269/AQNS7hs0T5k8qHYyruAadWa06tc-l9yfXQNov844gCJMkLeeWIwUGGqAyXc09DXrzm-xgSuYkG-mJC40NrPSDT27cnHp0qkPnhps9c87WA?ccb=9-4&oh=01_Q5Aa5QFrY5NWhv0rBtepq1B2FOe25-8fI_T0Kw_hm6iSa9UQMg&oe=68D2F1A5&_nc_sid=5e03e0';

const TIMEOUT_ERROR = `Get "${MEDIA_URL}": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`;

/** The logger's own cap, mirrored here so this test fails if the cap moves. */
const MAX_LOG_VALUE_CHARS = 240;

describe('compactUrls', () => {
  it('keeps the cause that the URL used to push out of the log', () => {
    const compact = compactUrls(TIMEOUT_ERROR);

    expect(compact).toContain('context deadline exceeded');
    expect(compact).toContain('mmg.whatsapp.net');
    expect(compact).not.toContain('_nc_sid');
  });

  it('leaves a message short enough for the cause to survive truncation', () => {
    // The bug, stated exactly: the logger renders an error as `name: message`
    // and cuts the result at 240 characters. The URL alone is ~240 of those, so
    // the cut landed before the cause and every failure logged `reason=unknown`.
    expect(`WacliCommandError: ${TIMEOUT_ERROR}`.slice(0, MAX_LOG_VALUE_CHARS)).not.toContain(
      'context deadline exceeded'
    );
    expect(`WacliCommandError: ${compactUrls(TIMEOUT_ERROR)}`.length).toBeLessThan(
      MAX_LOG_VALUE_CHARS
    );
  });

  it('leaves a message with no URL in it alone', () => {
    expect(compactUrls('sql: no rows in result set')).toBe('sql: no rows in result set');
  });

  it('collapses every URL in a message, not just the first', () => {
    const compact = compactUrls(`Get "${MEDIA_URL}" then "${MEDIA_URL}": EOF`);
    expect(compact).toBe('Get "mmg.whatsapp.net" then "mmg.whatsapp.net": EOF');
  });

  it('does not throw on something that only looks like a URL', () => {
    expect(compactUrls('Get "http://[not-a-host": EOF')).toBe('Get "<url>": EOF');
    // No URL to collapse at all, so nothing is touched.
    expect(compactUrls('http://')).toBe('http://');
  });
});

describe('parseHttpStatus', () => {
  it('reads the status wacli reports', () => {
    expect(parseHttpStatus('download failed with status code 403')).toBe(403);
    expect(parseHttpStatus('unexpected HTTP 503 from media host')).toBe(503);
    expect(parseHttpStatus('media fetch returned 404 Not Found')).toBe(404);
  });

  it('never reads a status out of the media URL', () => {
    // A media path segment or token can contain any three digits by chance.
    const url = 'https://mmg.whatsapp.net/o1/v/t24/f2/m403/AQ403zzz?ccb=9-4&oe=68D2F1A5';
    expect(parseHttpStatus(`Get "${url}": EOF`)).toBeNull();
  });

  it('returns null when no status is named', () => {
    expect(parseHttpStatus(TIMEOUT_ERROR)).toBeNull();
  });
});

describe('isTransientFailure', () => {
  it('recognises the network failures Go reports', () => {
    expect(isTransientFailure(TIMEOUT_ERROR)).toBe(true);
    expect(isTransientFailure('net/http: TLS handshake timeout')).toBe(true);
    expect(isTransientFailure('dial tcp: lookup mmg.whatsapp.net: no such host')).toBe(true);
    expect(isTransientFailure('read tcp 10.0.0.2:443: connection reset by peer')).toBe(true);
    expect(isTransientFailure('unexpected EOF')).toBe(true);
  });

  it('treats a busy store as transient, as it always did', () => {
    expect(isTransientFailure('store is locked (another wacli is running?)')).toBe(true);
  });

  it('treats a retryable status as transient and a terminal one as final', () => {
    expect(isTransientFailure('download failed with status code 503')).toBe(true);
    expect(isTransientFailure('download failed with status code 429')).toBe(true);
    expect(isTransientFailure('download failed with status code 403')).toBe(false);
    expect(isTransientFailure('download failed with status code 404')).toBe(false);
  });

  it('does not treat missing local rows as worth retrying', () => {
    expect(isTransientFailure('sql: no rows in result set')).toBe(false);
  });
});

describe('describeDownloadFailure', () => {
  it('names a timeout instead of shrugging at it', () => {
    // This is the log line that started this: reason=unknown, at WARN, with the
    // one piece of information that would have explained it truncated away.
    expect(describeDownloadFailure(new Error(TIMEOUT_ERROR))).toEqual({
      reason: 'whatsapp-unreachable',
      expected: false,
    });
  });

  it('still reports expired media as the routine outcome it is', () => {
    expect(describeDownloadFailure(new Error('download failed with status code 403'))).toEqual({
      reason: 'expired-on-whatsapp',
      expected: true,
    });
  });

  it('does not call a message expired because its URL contains 403', () => {
    const url = 'https://mmg.whatsapp.net/o1/v/t24/f2/m403/AQ403zzz?ccb=9-4';
    expect(describeDownloadFailure(new Error(`Get "${url}": unexpected EOF`)).reason).toBe(
      'whatsapp-unreachable'
    );
  });

  it('keeps the store-lock and missing-row cases quiet', () => {
    expect(describeDownloadFailure(new Error('store is locked (pid=123)'))).toEqual({
      reason: 'store-locked',
      expected: true,
    });
    expect(describeDownloadFailure(new Error('sql: no rows in result set'))).toEqual({
      reason: 'not-in-local-store',
      expected: true,
    });
  });

  it('falls back to unknown only for something genuinely unrecognised', () => {
    expect(describeDownloadFailure(new Error('segmentation fault')).reason).toBe('unknown');
  });
});
