import { isStoreLockMessage } from './store-lock.js';

/**
 * Go renders a failed request as `Get "<url>": <cause>`, and a WhatsApp media
 * URL is roughly 250 characters of opaque query string — long enough on its own
 * to push the cause past the log's per-field cap. That is what left every media
 * download failure logged as `reason=unknown` with a truncated URL and nothing
 * else: the half of the message that said *why* was the half being cut.
 *
 * The URL identifies nothing that `chat` and `id` do not already say, so only
 * the host survives. It also keeps the URL's random base64 away from the
 * classifiers below, which match on three-digit status codes and would
 * otherwise hit on a path segment that happens to contain one.
 */
export function compactUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"]+/g, (url) => {
    try {
      return new URL(url).host;
    } catch {
      return '<url>';
    }
  });
}

/**
 * How wacli spells out an HTTP status it got back from WhatsApp. Matched
 * against the compacted message so a status is only ever read from prose, never
 * from inside the media URL.
 */
const STATUS_PATTERNS = [
  /\bstatus(?:\s+code)?[:\s]+(\d{3})\b/i,
  /\bHTTP[/ ](?:\d(?:\.\d)?\s+)?(\d{3})\b/i,
  /\b(\d{3})\s+(?:Forbidden|Not Found|Unauthorized|Gone|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i,
];

/** The HTTP status a download failure names, or null if it names none. */
export function parseHttpStatus(message: string): number | null {
  const compact = compactUrls(message);
  for (const pattern of STATUS_PATTERNS) {
    const match = pattern.exec(compact);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Network-layer failures, as Go's http client and net package word them. */
const TRANSIENT_PATTERNS = [
  /context deadline exceeded/i,
  /client\.timeout/i,
  /tls handshake timeout/i,
  /i\/o timeout/i,
  /connection (?:reset|refused)/i,
  // Our own execFile deadline, as classifyCommandError words it. A command we
  // stopped says nothing about whether it would have worked given longer.
  /command timed out/i,
  /no such host/i,
  /network is (?:unreachable|down)/i,
  /broken pipe/i,
  /\bEOF\b/,
];

/** Statuses worth asking about again; 403 and 404 are WhatsApp saying "gone". */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Whether a failure says something about the moment the media was asked for
 * rather than about the media itself — the store was busy, or the network was.
 *
 * The distinction is what the negative cache turns on. Remembering an expired
 * attachment for minutes is the point of that cache; remembering a two-second
 * network blip for the same five minutes left a perfectly downloadable
 * attachment broken on screen long after the condition had cleared.
 */
export function isTransientFailure(message: string): boolean {
  if (isStoreLockMessage(message)) return true;

  const status = parseHttpStatus(message);
  if (status !== null) return TRANSIENT_STATUSES.has(status);

  const compact = compactUrls(message);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(compact));
}
