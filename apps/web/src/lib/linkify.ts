/**
 * Finds the web links in a message body, so they can be clicked rather than
 * copied out by hand.
 *
 * Every body was written by somebody else, so this is deliberately narrow:
 * `http://`, `https://` and bare `www.` only. Anything else that looks like a
 * link — `javascript:`, `data:`, `file:`, `ftp:`, `mailto:` — stays text, and a
 * candidate that `URL` cannot parse stays text too.
 */
export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string };

/**
 * A scheme or `www.` at a word boundary, then everything up to whitespace or a
 * character that never belongs in a link written in prose. The boundary keeps
 * `xhttps://` and `awww.` from matching mid-word.
 */
const CANDIDATE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

/** Punctuation that ends a sentence rather than a URL: "see https://a.example." */
const TRAILING_PUNCTUATION = /[.,;:!?'*]+$/;

/**
 * Trims what prose wrapped around the link. A closing bracket goes only when
 * the link has more closers than openers, so "(https://a.example)" loses it
 * and "https://en.wikipedia.org/wiki/Engine_(computing)" keeps it.
 */
function trimProse(candidate: string): string {
  let url = candidate;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING_PUNCTUATION, '');
    for (const [open, close] of [['(', ')'], ['[', ']']] as const) {
      if (url.endsWith(close) && count(url, close) > count(url, open)) {
        url = url.slice(0, -1);
      }
    }
    if (url === before) return url;
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** The address a candidate opens, or null when it is not a web link at all. */
function hrefFor(url: string): string | null {
  const absolute = /^www\./i.test(url) ? `https://${url}` : url;
  try {
    const parsed = new URL(absolute);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // "https://..." or "http://intranet" in prose is a mention, not somewhere
    // worth sending the operator: a link needs a dotted host.
    if (!parsed.hostname || (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost')) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;

  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index;
    const url = trimProse(match[0]);
    const href = hrefFor(url);
    if (!href) continue;

    if (start > cursor) parts.push({ kind: 'text', text: text.slice(cursor, start) });
    parts.push({ kind: 'link', text: url, href });
    cursor = start + url.length;
  }

  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor) });
  return parts;
}
