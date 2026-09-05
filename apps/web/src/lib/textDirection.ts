/**
 * Which way a body of message text runs.
 *
 * Every surface in the console is laid out for Latin script, so a Hebrew
 * message inherited the page's left-to-right direction: it hugged the wrong
 * edge of its bubble and — worse — trailing punctuation jumped to the wrong
 * end, turning `שלום!` into `!שלום`.
 * Deciding the direction per message and stamping `dir` on the element that
 * holds it hands the browser's bidi algorithm the right paragraph direction,
 * and both problems go away.
 */

export type TextDirection = 'ltr' | 'rtl';

/**
 * Strong right-to-left letters: Hebrew and its presentation forms, plus Arabic
 * with its supplements and both presentation-form blocks.
 *
 * Arabic is here because it is the same defect with the same fix — an Arabic
 * message left-aligned is as wrong as a Hebrew one — and leaving it out would
 * only mean knowingly keeping half the break.
 */
const RTL_LETTERS =
  /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/g;

/** Strong left-to-right letters: Latin, Greek and Cyrillic. */
const LTR_LETTERS = /[A-Za-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02AF\u0370-\u04FF]/g;

function countMatches(text: string, letters: RegExp): number {
  return text.match(letters)?.length ?? 0;
}

/**
 * The direction to render `text` in.
 *
 * The rule is the majority of strong letters, not the first one. HTML's own
 * `dir="auto"` uses first-strong, and that reads real chat traffic badly: a
 * Hebrew message opening with a name, a brand or a URL scores as English and
 * left-aligns the whole line, and in the chat rail the `You: ` prefix would
 * decide the direction of every preview. Counting is symmetric — an English
 * sentence quoting one Hebrew word stays left-to-right.
 *
 * Text with no strong letters at all — an emoji, a phone number, a bare URL —
 * is left-to-right, matching the console around it.
 */
export function detectTextDirection(text: string | null | undefined): TextDirection {
  if (!text) return 'ltr';

  const rtl = countMatches(text, RTL_LETTERS);
  if (rtl === 0) return 'ltr';

  return rtl > countMatches(text, LTR_LETTERS) ? 'rtl' : 'ltr';
}
