import type { QuickReplyTemplate } from '../types.ts';

/** The option element's id, for the textarea's aria-activedescendant. */
export function templateOptionId(pickerId: string, index: number): string {
  return `${pickerId}-option-${index}`;
}

/** More than this and the picker is a list to read, not a choice to make. */
export const MAX_PICKER_RESULTS = 8;

/**
 * What the operator is searching templates for, or null when the draft is not
 * asking for one.
 *
 * A draft that starts with `/` and is still on its first line is a search: `/`
 * alone lists everything, `/late` narrows it. Once there is a newline it is a
 * message that happens to start with a slash.
 */
export function templateQuery(draft: string): string | null {
  if (!draft.startsWith('/') || draft.includes('\n')) return null;
  return draft.slice(1);
}

/**
 * The templates worth offering for a query, best first.
 *
 * Names that start with the query, then names that contain it, then bodies
 * that contain it. Within each group the server's order holds, which is most
 * recently used first.
 */
export function matchTemplates(
  templates: readonly QuickReplyTemplate[],
  query: string
): QuickReplyTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return templates.slice(0, MAX_PICKER_RESULTS);

  const ranked: QuickReplyTemplate[][] = [[], [], []];
  for (const template of templates) {
    const name = template.name.toLowerCase();
    if (name.startsWith(q)) ranked[0].push(template);
    else if (name.includes(q)) ranked[1].push(template);
    else if (template.body.toLowerCase().includes(q)) ranked[2].push(template);
  }
  return ranked.flat().slice(0, MAX_PICKER_RESULTS);
}

/**
 * The draft once a template goes in.
 *
 * Picked by typing `/`, the template replaces the search that found it. Picked
 * from the button, the draft may already hold a sentence, so the template goes
 * in at the caret rather than over the top of it.
 */
export function insertTemplate(
  draft: string,
  body: string,
  caret: number,
  replaceDraft: boolean
): { draft: string; caret: number } {
  if (replaceDraft) return { draft: body, caret: body.length };
  const at = Math.min(Math.max(0, caret), draft.length);
  return { draft: draft.slice(0, at) + body + draft.slice(at), caret: at + body.length };
}
