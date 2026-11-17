import { describe, it, expect } from 'vitest';
import { insertTemplate, matchTemplates, MAX_PICKER_RESULTS, templateQuery } from './templatePicker.ts';
import type { QuickReplyTemplate } from '../types.ts';

function template(name: string, body = `${name} body`): QuickReplyTemplate {
  return {
    id: name,
    name,
    body,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    lastUsedAt: null,
  };
}

describe('templateQuery', () => {
  it('reads a leading slash on the first line as a search', () => {
    expect(templateQuery('/')).toBe('');
    expect(templateQuery('/late')).toBe('late');
    expect(templateQuery('/running late')).toBe('running late');
  });

  it('leaves every other draft alone', () => {
    expect(templateQuery('')).toBeNull();
    expect(templateQuery('see /etc/hosts')).toBeNull();
    expect(templateQuery('/shrug\nsecond line')).toBeNull();
  });
});

describe('matchTemplates', () => {
  const templates = [
    template('Thanks', 'Thank you, Ada!'),
    template('Running late', 'Ten minutes behind.'),
    template('Address', 'The engine room is late on Tuesdays.'),
    template('Later', 'Talk later.'),
  ];

  it('offers everything, in the order given, for an empty search', () => {
    expect(matchTemplates(templates, '').map((t) => t.name)).toEqual([
      'Thanks',
      'Running late',
      'Address',
      'Later',
    ]);
  });

  it('ranks a name prefix over a name match over a body match', () => {
    expect(matchTemplates(templates, 'LATE').map((t) => t.name)).toEqual([
      'Later',
      'Running late',
      'Address',
    ]);
  });

  it('finds nothing when nothing matches', () => {
    expect(matchTemplates(templates, 'zzz')).toEqual([]);
  });

  it('stops at the cap', () => {
    const many = Array.from({ length: MAX_PICKER_RESULTS + 5 }, (_, i) => template(`t${i}`));
    expect(matchTemplates(many, '')).toHaveLength(MAX_PICKER_RESULTS);
    expect(matchTemplates(many, 't')).toHaveLength(MAX_PICKER_RESULTS);
  });
});

describe('insertTemplate', () => {
  it('replaces the search that found it', () => {
    expect(insertTemplate('/lat', 'Running late.', 4, true)).toEqual({ draft: 'Running late.', caret: 13 });
  });

  it('goes in at the caret when the draft already says something', () => {
    expect(insertTemplate('Hi  bye', 'there', 3, false)).toEqual({ draft: 'Hi there bye', caret: 8 });
    expect(insertTemplate('', 'there', 0, false)).toEqual({ draft: 'there', caret: 5 });
    expect(insertTemplate('ab', 'X', 99, false)).toEqual({ draft: 'abX', caret: 3 });
  });
});
