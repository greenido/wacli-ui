import { describe, it, expect } from 'vitest';
import { normalizeTag, suggestTags, findSimilarTag } from './tagSuggest.ts';

const VOCAB = ['client', 'family', 'follow-up', 'ops', 'work', 'work-travel'];

describe('normalizeTag', () => {
  it('folds a tag the way the server will store it', () => {
    expect(normalizeTag('  Follow Up ')).toBe('follow-up');
    expect(normalizeTag('WORK\t\tTRAVEL')).toBe('work-travel');
  });

  it('truncates at the same 32 characters the server does', () => {
    expect(normalizeTag('x'.repeat(40))).toHaveLength(32);
  });
});

describe('suggestTags', () => {
  it('offers the whole vocabulary for an empty draft, so a half-remembered tag is findable', () => {
    expect(suggestTags('', VOCAB)).toEqual(VOCAB);
  });

  it('puts prefix matches ahead of tags that merely contain the draft', () => {
    expect(suggestTags('work', VOCAB)).toEqual(['work', 'work-travel']);
    expect(suggestTags('travel', VOCAB)).toEqual(['work-travel']);
  });

  it('matches on the normalized draft, not the raw keystrokes', () => {
    expect(suggestTags('Follow Up', VOCAB)).toEqual(['follow-up']);
  });

  it('drops tags the chat already carries, since re-adding one does nothing', () => {
    expect(suggestTags('work', VOCAB, ['work'])).toEqual(['work-travel']);
  });

  it('caps the list so the popup never outgrows the modal', () => {
    expect(suggestTags('', VOCAB, [], 2)).toEqual(['client', 'family']);
  });

  it('returns nothing for a genuinely new tag', () => {
    expect(suggestTags('regatta', VOCAB)).toEqual([]);
  });
});

describe('findSimilarTag', () => {
  it('catches a near-duplicate neither string contains', () => {
    expect(findSimilarTag('followup', VOCAB)).toBe('follow-up');
    expect(findSimilarTag('familly', VOCAB)).toBe('family');
  });

  it('catches a plural of an existing tag', () => {
    expect(findSimilarTag('clients', VOCAB)).toBe('client');
  });

  it('stays quiet on an exact hit, which is the tag rather than a near-miss', () => {
    expect(findSimilarTag('work', VOCAB)).toBeNull();
    expect(findSimilarTag(' Work ', VOCAB)).toBeNull();
  });

  it('stays quiet on short tags, where every tag is one edit from every other', () => {
    expect(findSimilarTag('op', VOCAB)).toBeNull();
    expect(findSimilarTag('vip', VOCAB)).toBeNull();
  });

  it('stays quiet on a tag that is simply new', () => {
    expect(findSimilarTag('regatta', VOCAB)).toBeNull();
  });

  it('allows only one edit on a short tag, so distinct short tags stay distinct', () => {
    expect(findSimilarTag('worm', ['work'])).toBe('work');
    expect(findSimilarTag('worms', ['work'])).toBeNull();
  });

  it('names the same tag every time when two are equally close', () => {
    expect(findSimilarTag('bost', ['boat', 'host'])).toBe('boat');
    expect(findSimilarTag('bost', ['host', 'boat'])).toBe('boat');
  });
});
