import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from './appStore.ts';
import type { UnifiedMessage } from '../types.ts';

const ALICE = 'alice@s.whatsapp.net';
const BOB = 'bob@s.whatsapp.net';

function message(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: ALICE,
    chatName: 'Alice',
    msgId: 'MSG-A1',
    senderJid: ALICE,
    senderName: 'Alice',
    ts: '2026-09-01T10:00:00Z',
    fromMe: false,
    text: 'the wire transfer went out',
    displayText: 'the wire transfer went out',
    isForwarded: false,
    reactionToId: null,
    reactionEmoji: null,
    mediaType: null,
    mediaCaption: null,
    filename: null,
    mimeType: null,
    localPath: null,
    starred: false,
    bookmarked: false,
    edited: false,
    revoked: false,
    ...over,
  };
}

describe('composer state is scoped to a conversation', () => {
  beforeEach(() => {
    useAppStore.setState({ composerDrafts: {}, composerFiles: {}, replyingToByChat: {} });
  });

  it('keeps a draft with the chat it was typed in', () => {
    const { setComposerDraft } = useAppStore.getState();
    setComposerDraft(ALICE, 'half-written note to Alice');

    const state = useAppStore.getState();
    expect(state.composerDrafts[ALICE]).toBe('half-written note to Alice');
    // The single shared draft used to follow the operator into the next chat.
    expect(state.composerDrafts[BOB]).toBeUndefined();
  });

  it('does not carry a reply target across chats', () => {
    const { setReplyingTo } = useAppStore.getState();
    setReplyingTo(ALICE, message());

    const state = useAppStore.getState();
    expect(state.replyingToByChat[ALICE]?.msgId).toBe('MSG-A1');
    // Sending in Bob's thread must not quote a message from Alice's.
    expect(state.replyingToByChat[BOB]).toBeUndefined();
  });

  it('clears the reply target for one chat only', () => {
    const { setReplyingTo } = useAppStore.getState();
    setReplyingTo(ALICE, message());
    setReplyingTo(BOB, message({ chatJid: BOB, msgId: 'MSG-B1' }));

    useAppStore.getState().setReplyingTo(ALICE, null);

    const state = useAppStore.getState();
    expect(state.replyingToByChat[ALICE]).toBeUndefined();
    expect(state.replyingToByChat[BOB]?.msgId).toBe('MSG-B1');
  });

  it('clears only the sent conversation after a dispatch', () => {
    const store = useAppStore.getState();
    store.setComposerDraft(ALICE, 'to Alice');
    store.setComposerDraft(BOB, 'to Bob');
    store.setReplyingTo(ALICE, message());
    store.setComposerFile(ALICE, new File(['x'], 'a.txt'));

    useAppStore.getState().clearComposer(ALICE);

    const state = useAppStore.getState();
    expect(state.composerDrafts[ALICE]).toBeUndefined();
    expect(state.composerFiles[ALICE]).toBeUndefined();
    expect(state.replyingToByChat[ALICE]).toBeUndefined();
    expect(state.composerDrafts[BOB]).toBe('to Bob');
  });

  it('drops the key instead of leaving an empty draft behind', () => {
    const store = useAppStore.getState();
    store.setComposerDraft(ALICE, 'typed');
    store.setComposerDraft(ALICE, '');

    expect(ALICE in useAppStore.getState().composerDrafts).toBe(false);
  });
});
