import React from 'react';
import { splitLinks } from '../../lib/linkify.ts';

/**
 * A message body with its web links clickable.
 *
 * Opened in a new tab with no opener and no referrer: the site learns nothing
 * about the console, and cannot reach back into it. The hover title is the
 * parsed address rather than the text as written, so a lookalike domain shows
 * its real (punycode) name before the click.
 */
export function LinkifiedText({ text }: { text: string }) {
  const parts = splitLinks(text);
  return (
    <>
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        ) : (
          <a
            key={i}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            title={part.href}
            className="text-mc-accent underline decoration-mc-accent/40 underline-offset-2 hover:decoration-mc-accent break-all"
          >
            {part.text}
          </a>
        )
      )}
    </>
  );
}
