/**
 * Tag autocomplete for the chat info modal.
 *
 * Tags are free text typed by one operator over months, so the failure mode is
 * not a wrong tag but a drifting one: `follow-up`, `followup` and `follow up`
 * label the same idea and none of them filter the rail together. Everything
 * here exists to make an existing tag the cheapest thing to type.
 */

/**
 * Client twin of `normalizeTag` in `apps/api/src/wacli/tags.ts`.
 *
 * The server folds a tag on write either way; running the same fold in the box
 * means the operator is matched against — and warned about — the tag that will
 * actually be stored, not the one they typed. Keep the two in step.
 */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);
}

/**
 * Existing tags worth offering for `draft`, prefix matches first.
 *
 * An empty draft offers the whole vocabulary — opening the list is how an
 * operator reuses a tag they only half remember. Tags already on this chat are
 * dropped, since adding one again is a no-op. `allTags` arrives sorted from
 * `/api/tags` and that order is preserved inside each match band.
 */
export function suggestTags(
  draft: string,
  allTags: readonly string[],
  alreadyOnChat: readonly string[] = [],
  limit = 6
): string[] {
  const onChat = new Set(alreadyOnChat.map(normalizeTag));
  const pool = allTags.filter((tag) => !onChat.has(tag));

  const needle = normalizeTag(draft);
  if (!needle) return pool.slice(0, limit);

  const prefix: string[] = [];
  const infix: string[] = [];
  for (const tag of pool) {
    if (tag.startsWith(needle)) prefix.push(tag);
    else if (tag.includes(needle)) infix.push(tag);
  }

  return [...prefix, ...infix].slice(0, limit);
}

/**
 * The existing tag `draft` is a typo or two away from, or null.
 *
 * This catches the near-miss `suggestTags` cannot see, because neither string
 * contains the other: `followup` against `follow-up`, `familly` against
 * `family`. Short tags are exempt — under three characters every tag is one
 * edit from every other one — and an exact hit is not a near-miss at all.
 */
export function findSimilarTag(draft: string, allTags: readonly string[]): string | null {
  const needle = normalizeTag(draft);
  if (needle.length < 3) return null;
  if (allTags.includes(needle)) return null;

  let best: string | null = null;
  let bestDistance = Infinity;

  for (const tag of allTags) {
    // One edit buys a plural or a dropped letter; a second is only safe once
    // there is enough tag left for it not to be a different word.
    const budget = Math.min(needle.length, tag.length) <= 4 ? 1 : 2;
    if (Math.abs(tag.length - needle.length) > budget) continue;

    const distance = editDistance(needle, tag, budget);
    if (distance > budget) continue;

    // Alphabetical tie-break, so the same draft always names the same tag.
    if (distance < bestDistance || (distance === bestDistance && best !== null && tag < best)) {
      best = tag;
      bestDistance = distance;
    }
  }

  return best;
}

/** Levenshtein distance, abandoned as soon as every path has passed `max`. */
function editDistance(a: string, b: string, max: number): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;

    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const next = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      row.push(next);
      if (next < rowMin) rowMin = next;
    }

    if (rowMin > max) return max + 1;
    prev = row;
  }

  return prev[b.length];
}
