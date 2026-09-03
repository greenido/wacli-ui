import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store/appStore.ts';
import { markChatAsRead } from '../lib/chatRead.ts';
import { messagePreviewText } from '../lib/messagePreview.ts';
import { sameWhatsAppUser } from '../lib/presence.ts';
import type { MissionControlEvent, MissionControlStatus, UnifiedChat, UnifiedMessage } from '../types.ts';

/**
 * How long to hold a chat-list refetch open so a burst of messages from chats
 * the rail has never seen costs one request instead of one per message.
 */
const CHATS_REFETCH_COALESCE_MS = 1_000;

export function useWebSocket() {
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let chatsRefetchTimer: ReturnType<typeof setTimeout> | null = null;
    let shouldReconnect = true;

    // `/api/chats` costs a `chats list` plus a ~300 KB message scan, so it is
    // asked for only when the cache genuinely cannot be patched in place.
    function scheduleChatsRefetch() {
      if (chatsRefetchTimer) return;
      chatsRefetchTimer = setTimeout(() => {
        chatsRefetchTimer = null;
        void queryClient.invalidateQueries({ queryKey: ['chats'] });
      }, CHATS_REFETCH_COALESCE_MS);
    }

    function connect() {
      const defaultWsUrl =
        typeof window !== 'undefined'
          ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`
          : 'ws://127.0.0.1:3002/ws';
      const wsUrl = import.meta.env.VITE_WS_URL ?? defaultWsUrl;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        // Refresh health and current chat data on connect
        queryClient.invalidateQueries({ queryKey: ['health'] });
        queryClient.invalidateQueries({ queryKey: ['chats'] });
      };

      ws.onclose = () => {
        setIsConnected(false);
        if (shouldReconnect) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      };

      ws.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as MissionControlEvent;

          if (payload.type === 'message.new') {
            const newMsg = payload.data;

            // 1. Reconcile into the active thread cache. The thread is keyed by
            //    chat *and* window size, so match on the prefix: a widened
            //    window is a different key holding the same conversation.
            queryClient.setQueriesData<{ messages: UnifiedMessage[]; hasMore: boolean }>(
              { queryKey: ['messages', newMsg.chatJid] },
              (old) => {
                // Nothing loaded yet: the fetch already in flight will carry it.
                if (!old) return old;
                if (old.messages.some((m) => m.msgId === newMsg.msgId)) {
                  return old; // dedupe
                }
                return {
                  ...old,
                  messages: [newMsg, ...old.messages],
                };
              }
            );

            // 2. Reconcile into chats list cache
            const selectedJid = useAppStore.getState().selectedChat?.jid;
            const isViewingChat = selectedJid === newMsg.chatJid;

            // A reaction is not conversation content — the server-side preview scan
            // skips it, so the rail keeps showing the message being reacted to.
            const preview = newMsg.reactionToId ? null : messagePreviewText(newMsg);
            let chatIsInRail = false;

            queryClient.setQueriesData<UnifiedChat[]>({ queryKey: ['chats'] }, (old) => {
              if (!old) return old;
              if (!old.some((c) => c.jid === newMsg.chatJid)) return old;
              chatIsInRail = true;

              return old.map((c) => {
                if (c.jid !== newMsg.chatJid) return c;

                const patched = preview
                  ? { ...c, lastMessage: preview, lastMessageFromMe: newMsg.fromMe }
                  : c;

                if (isViewingChat) {
                  if (!newMsg.fromMe) {
                    void markChatAsRead(queryClient, newMsg.chatJid);
                  }
                  return {
                    ...patched,
                    lastMessageTs: newMsg.ts,
                    unread: false,
                    unreadCount: 0,
                  };
                }

                // The next poll reconciles against the store's own unread_count;
                // bumping it here is what makes the badge move immediately.
                return newMsg.fromMe
                  ? { ...patched, lastMessageTs: newMsg.ts }
                  : {
                      ...patched,
                      lastMessageTs: newMsg.ts,
                      unread: true,
                      unreadCount: c.unreadCount + 1,
                    };
              }).sort((a, b) => {
                const tsA = a.lastMessageTs ? new Date(a.lastMessageTs).getTime() : 0;
                const tsB = b.lastMessageTs ? new Date(b.lastMessageTs).getTime() : 0;
                return tsB - tsA;
              });
            });

            // The rail row is now correct without a round trip. Only a chat the
            // rail has never seen still needs one.
            if (!chatIsInRail) {
              scheduleChatsRefetch();
            }

            if (!newMsg.fromMe) {
              useAppStore.getState().clearPresence(newMsg.chatJid);
            }
          } else if (payload.type === 'message.receipt') {
            const { chatJid, messageIds, status } = payload.data;
            queryClient.setQueriesData<{ messages: UnifiedMessage[]; hasMore: boolean }>(
              { queryKey: ['messages', chatJid] },
              (old) => {
                if (!old) return old;
                return {
                  ...old,
                  messages: old.messages.map((m) => {
                    if (messageIds.includes(m.msgId)) {
                      return { ...m, deliveryStatus: status };
                    }
                    return m;
                  }),
                };
              }
            );
          } else if (payload.type === 'chat.presence') {
            const { chatJid, state, senderJid } = payload.data;
            const health = queryClient.getQueryData<MissionControlStatus>(['health']);
            const linkedJid = health?.doctor?.linkedJid;
            if (linkedJid && senderJid && sameWhatsAppUser(senderJid, linkedJid)) {
              return;
            }
            useAppStore.getState().setPresence(chatJid, state, senderJid);
          } else if (payload.type === 'scheduled.update') {
            queryClient.invalidateQueries({ queryKey: ['scheduled'] });
          } else if (payload.type === 'connection.status') {
            queryClient.invalidateQueries({ queryKey: ['health'] });
            if (payload.data.state === 'connected') {
              queryClient.invalidateQueries({ queryKey: ['chats'] });
              const currentSelectedChat = useAppStore.getState().selectedChat;
              if (currentSelectedChat) {
                queryClient.invalidateQueries({ queryKey: ['messages', currentSelectedChat.jid] });
              }
            }
          }
        } catch {
          // ignore parse error
        }
      };
    }

    connect();

    return () => {
      shouldReconnect = false;
      clearTimeout(reconnectTimer);
      if (chatsRefetchTimer) clearTimeout(chatsRefetchTimer);
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
          wsRef.current.close();
        }
      }
    };
  }, [queryClient]);

  return { isConnected };
}
