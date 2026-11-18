import { describe, it, expect } from 'vitest';
import { DEFAULT_NUDGE_TEXT, describeWaiting, nudgeText, remindPresets, sentAgo } from './waiting.ts';
import type { QuickReplyTemplate, UnifiedMessage, WaitingItem } from '../types.ts';

function template(name: string, body: string): QuickReplyTemplate {
  return { id: name, name, body, createdAt: '', updatedAt: '', lastUsedAt: null };
}

function item(deliveryStatus: UnifiedMessage['deliveryStatus'], chatName = 'Ada Lovelace'): WaitingItem {
  return {
    chatJid: '15550100001@s.whatsapp.net',
    chatName,
    message: { deliveryStatus, ts: '2026-11-16T10:00:00Z' } as UnifiedMessage,
    snoozedUntil: null,
  };
}

describe('nudgeText', () => {
  it('uses the operator’s own follow-up template', () => {
    const templates = [template('Running late', 'Ten minutes out.'), template('Follow-up', 'Any thoughts?')];
    expect(nudgeText(templates)).toBe('Any thoughts?');
  });

  it('recognises a template named for nudging', () => {
    expect(nudgeText([template('nudge', 'Bump!')])).toBe('Bump!');
  });

  it('falls back to a plain line when there is no such template, or no templates yet', () => {
    expect(nudgeText([template('Running late', 'Ten minutes out.')])).toBe(DEFAULT_NUDGE_TEXT);
    expect(nudgeText(undefined)).toBe(DEFAULT_NUDGE_TEXT);
  });

  it('skips a follow-up template with nothing in it', () => {
    expect(nudgeText([template('Follow up', '   ')])).toBe(DEFAULT_NUDGE_TEXT);
  });
});

describe('describeWaiting', () => {
  it('says who read it', () => {
    expect(describeWaiting(item('read'))).toBe('Ada Lovelace read this');
  });

  it('says a voice note was played', () => {
    expect(describeWaiting(item('played'))).toBe('Ada Lovelace played this');
  });

  it('says it was only delivered when no read receipt came', () => {
    expect(describeWaiting(item('delivered'))).toBe('Delivered to Ada Lovelace');
  });

  it('falls back to the number when the chat has no name', () => {
    expect(describeWaiting(item('read', ''))).toBe('15550100001 read this');
  });
});

describe('sentAgo', () => {
  const now = new Date('2026-11-18T12:00:00Z');

  it.each([
    ['2026-11-18T11:59:30Z', 'just now'],
    ['2026-11-18T11:15:00Z', '45 min ago'],
    ['2026-11-18T07:00:00Z', '5h ago'],
    ['2026-11-17T11:00:00Z', '1 day ago'],
    ['2026-11-16T10:00:00Z', '2 days ago'],
    ['2026-10-28T12:00:00Z', '3 weeks ago'],
  ])('describes %s as %s', (ts, expected) => {
    expect(sentAgo(ts, now)).toBe(expected);
  });

  it('does not go negative for a clock slightly ahead', () => {
    expect(sentAgo('2026-11-18T12:00:05Z', now)).toBe('just now');
  });
});

describe('remindPresets', () => {
  it('offers times that are all in the future and in order', () => {
    const now = new Date('2026-11-18T22:30:00');
    const times = remindPresets(now).map((p) => new Date(p.until).getTime());
    expect(times.every((t) => t > now.getTime())).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('brings a reminder back in the morning, not at the late hour it was set', () => {
    const now = new Date('2026-11-18T22:30:00');
    const tomorrow = new Date(remindPresets(now)[1].until);
    expect(tomorrow.getDate()).toBe(19);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getMinutes()).toBe(0);
  });
});
