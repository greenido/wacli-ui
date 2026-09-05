import { describe, it, expect } from 'vitest';
import { detectTextDirection } from './textDirection.ts';

describe('detectTextDirection', () => {
  it('reads a Hebrew message right-to-left', () => {
    expect(detectTextDirection('שלום, מה שלומך?')).toBe('rtl');
  });

  it('leaves an English message alone', () => {
    expect(detectTextDirection('Hey, are we still on for tomorrow?')).toBe('ltr');
  });

  it('keeps a Hebrew message right-to-left when it opens with a Latin word', () => {
    // First-strong — what `dir="auto"` does — would call this English and
    // left-align the whole line. This is the case that made counting worth it.
    expect(detectTextDirection('Zoom בשעה 3, נתראה שם')).toBe('rtl');
  });

  it('keeps the chat rail preview right-to-left despite the You: prefix', () => {
    expect(detectTextDirection('You: אני בדרך, מגיע בעוד עשר דקות')).toBe('rtl');
  });

  it('leaves an English sentence quoting one Hebrew word left-to-right', () => {
    expect(detectTextDirection('The word for peace is שלום in Hebrew')).toBe('ltr');
  });

  it('reads Arabic right-to-left too', () => {
    expect(detectTextDirection('مرحبا كيف حالك')).toBe('rtl');
  });

  it('falls back to left-to-right for text with no letters at all', () => {
    expect(detectTextDirection('👍')).toBe('ltr');
    expect(detectTextDirection('+972-54-1234567')).toBe('ltr');
    expect(detectTextDirection('https://example.com/a/b?c=1')).toBe('ltr');
  });

  it('falls back to left-to-right for nothing at all', () => {
    expect(detectTextDirection('')).toBe('ltr');
    expect(detectTextDirection(null)).toBe('ltr');
    expect(detectTextDirection(undefined)).toBe('ltr');
  });

  it('does not carry regex state between calls', () => {
    // The letter classes are module-level and global; `String.match` resets
    // `lastIndex`, and this pins that down so a later switch to `exec` cannot
    // quietly start returning alternating answers.
    const hebrew = 'תודה רבה';
    expect(detectTextDirection(hebrew)).toBe('rtl');
    expect(detectTextDirection(hebrew)).toBe('rtl');
    expect(detectTextDirection(hebrew)).toBe('rtl');
  });
});
