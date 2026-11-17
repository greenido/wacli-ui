import { describe, it, expect } from 'vitest';
import { splitLinks, type TextPart } from './linkify.ts';

/** The links alone, as [text, href] pairs. */
function links(text: string): Array<[string, string]> {
  return splitLinks(text)
    .filter((p): p is Extract<TextPart, { kind: 'link' }> => p.kind === 'link')
    .map((p) => [p.text, p.href]);
}

describe('splitLinks', () => {
  it('leaves text with no links as one part', () => {
    expect(splitLinks('Is the engine ready?')).toEqual([{ kind: 'text', text: 'Is the engine ready?' }]);
    expect(splitLinks('')).toEqual([]);
  });

  it('finds http and https links, keeping the text around them', () => {
    expect(splitLinks('Notes: https://example.com/engine?page=2&ref=a#top then lunch')).toEqual([
      { kind: 'text', text: 'Notes: ' },
      {
        kind: 'link',
        text: 'https://example.com/engine?page=2&ref=a#top',
        href: 'https://example.com/engine?page=2&ref=a#top',
      },
      { kind: 'text', text: ' then lunch' },
    ]);
    expect(links('http://example.org')).toEqual([['http://example.org', 'http://example.org/']]);
  });

  it('opens a bare www. link over https', () => {
    expect(links('see www.example.org/notes')).toEqual([
      ['www.example.org/notes', 'https://www.example.org/notes'],
    ]);
  });

  it('finds every link in a message', () => {
    expect(links('https://a.example and https://b.example')).toHaveLength(2);
  });

  it('leaves sentence punctuation out of the link', () => {
    for (const [text, url] of [
      ['Read https://example.com.', 'https://example.com'],
      ['Read https://example.com/notes, then reply', 'https://example.com/notes'],
      ['Did you see https://example.com?!', 'https://example.com'],
      ["'https://example.com'", 'https://example.com'],
    ]) {
      expect(links(text).map(([t]) => t), text).toEqual([url]);
    }
  });

  it('drops a bracket the link did not open, and keeps one it did', () => {
    expect(links('(see https://example.com/notes)').map(([t]) => t)).toEqual([
      'https://example.com/notes',
    ]);
    expect(links('https://en.wikipedia.org/wiki/Engine_(computing)').map(([t]) => t)).toEqual([
      'https://en.wikipedia.org/wiki/Engine_(computing)',
    ]);
    expect(links('(https://en.wikipedia.org/wiki/Engine_(computing)).').map(([t]) => t)).toEqual([
      'https://en.wikipedia.org/wiki/Engine_(computing)',
    ]);
  });

  it('never links a scheme other than http or https', () => {
    for (const text of [
      'javascript:alert(1)',
      'data:text/html,<b>hi</b>',
      'file:///etc/hosts',
      'ftp://example.com/file',
      'mailto:ada@example.com',
    ]) {
      expect(links(text), text).toEqual([]);
    }
  });

  it('does not start a link mid-word', () => {
    expect(links('xhttps://example.com')).toEqual([]);
    expect(links('awww.example.com')).toEqual([]);
  });

  it('leaves a scheme with nowhere to go as text', () => {
    expect(links('the https:// prefix')).toEqual([]);
    expect(links('http://intranet')).toEqual([]);
    expect(links('https://...')).toEqual([]);
  });

  it('shows a lookalike domain by its real name in the href', () => {
    // A Cyrillic "а" in place of the Latin one.
    expect(links('https://exаmple.com')).toEqual([['https://exаmple.com', 'https://xn--exmple-4nf.com/']]);
  });

  it('keeps every character of the original text across the parts', () => {
    const text = 'a https://example.com/x. b (www.example.org) c javascript:alert(1)';
    expect(splitLinks(text).map((p) => p.text).join('')).toBe(text);
  });
});
