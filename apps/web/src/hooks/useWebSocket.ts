import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store/appStore.ts';
import { chatFromMessage } from '../lib/chatFromMessage.ts';
import { markChatAsRead } from '../lib/chatRead.ts';
import { messagePreviewText } from '../lib/messagePreview.ts';
import {
  notificationPermission,
  notificationsEnabled,
  notificationsSupported,
  shouldNotify,
  showMessageNotification,
} from '../lib/notifications.ts';
import { sameWhatsAppUser } from '../lib/presence.ts';
import { patchMessages, prependMessage, type MessagePages } from '../lib/messagePages.ts';
import type { MissionControlEvent, MissionControlStatus, UnifiedChat } from '../types.ts';

/**
 * How long to hold a chat-list refetch open so a burst of messages from chats
 * the rail has never seen costs one request instead of one per message.
 */
const CHATS_REFETCH_COALESCE_MS = 1_000;

/**
 * How long to wait before the first reconnect, and the ceiling it backs off to.
 *
 * The retry used to be a flat two seconds forever, so a console left open
 * against a stopped API reconnected thirty times a minute for as long as the
 * tab lived. Backing off keeps the common case fast — an API restarted during
 * development is back within a second — without the tab settling into a
 * permanent poll of something that is not there.
 */
export const WS_RECONNECT_BASE_MS = 1_000;
export const WS_RECONNECT_MAX_MS = 30_000;

/** The delay before reconnect attempt `attempt`, counting from zero. */
export function wsReconnectDelay(attempt: number): number {
  return Math.min(WS_RECONNECT_BASE_MS * 2 ** attempt, WS_RECONNECT_MAX_MS);
}

export function useWebSocket() {
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let chatsRefetchTimer: ReturnType<typeof setTimeout> | null = null;
    let shouldReconnect = true;
    let reconnectAttempts = 0;

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
        // A connection that came back is the end of the retry sequence, so the
        // next outage starts from a short delay rather than the last ceiling.
        reconnectAttempts = 0;
        // Refresh health and current chat data on connect
        queryClient.invalidateQueries({ queryKey: ['health'] });
        queryClient.invalidateQueries({ queryKey: ['chats'] });
      };

      ws.onclose = () => {
        setIsConnected(false);
        if (shouldReconnect) {
          reconnectTimer = setTimeout(connect, wsReconnectDelay(reconnectAttempts));
          reconnectAttempts += 1;
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

            // 1. Reconcile into the active thread cache. The thread holds its
            //    history as pages, so the insert goes on the front of the newest
            //    one and dedupes across all of them.
            queryClient.setQueriesData<MessagePages>(
              { queryKey: ['messages', newMsg.chatJid] },
              (old) => prependMessage(old, newMsg)
            );

            // 2. Reconcile into chats list cache
            const selectedJid = useAppStore.getState().selectedChat?.jid;
            const isViewingChat = selectedJid === newMsg.chatJid;

            // A reaction is not conversation content — the server-side preview scan
            // skips it, so the rail keeps showing the message being reacted to.
            const preview = newMsg.reactionToId ? null : messagePreviewText(newMsg);

            // Read before writing. An updater has to be pure: React Query runs
            // it once per query key matching `['chats']`, and StrictMode runs it
            // twice again — so gathering state inside one, as this used to,
            // meant the read receipt below could be sent several times for a
            // single message.
            const railChat = queryClient
              .getQueriesData<UnifiedChat[]>({ queryKey: ['chats'] })
              .flatMap(([, chats]) => chats ?? [])
              .find((c) => c.jid === newMsg.chatJid);
            const chatIsInRail = Boolean(railChat);

            queryClient.setQueriesData<UnifiedChat[]>({ queryKey: ['chats'] }, (old) => {
              if (!old) return old;
              if (!old.some((c) => c.jid === newMsg.chatJid)) return old;

              return old.map((c) => {
                if (c.jid !== newMsg.chatJid) return c;

                const patched = preview
                  ? { ...c, lastMessage: preview, lastMessageFromMe: newMsg.fromMe }
                  : c;

                if (isViewingChat) {
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

            // A message arriving in the conversation on screen has been read by
            // definition. Sent from out here, once, rather than from inside the
            // updater above — and no longer conditional on the chat being in
            // the rail, which was never what made it read.
            if (isViewingChat && !newMsg.fromMe) {
              markChatAsRead(queryClient, newMsg.chatJid);
            }

            // The rail row is now correct without a round trip. Only a chat the
            // rail has never seen still needs one.
            if (!chatIsInRail) {
              scheduleChatsRefetch();
            }

            if (!newMsg.fromMe) {
              useAppStore.getState().clearPresence(newMsg.chatJid);
            }

            // Desktop ping. The policy lives in lib/notifications so it can be
            // reasoned about without a socket; everything it needs is in hand.
            const notify = shouldNotify({
              msg: newMsg,
              chat: railChat,
              isViewingChat,
              documentVisible: document.visibilityState === 'visible' && document.hasFocus(),
              enabled: notificationsEnabled(),
              supported: notificationsSupported(),
              permission: notificationPermission(),
            });

            if (notify.show) {
              showMessageNotification(newMsg, () => {
                const target = railChat ?? chatFromMessage(newMsg);
                useAppStore.getState().setSelectedChat({ ...target, unread: false, unreadCount: 0 });
                try {
                  localStorage.setItem('wacli_selected_chat', target.jid);
                } catch {
                  // Selection still applies for this session.
                }
              });
            }
          } else if (payload.type === 'message.receipt') {
            const { chatJid, messageIds, status } = payload.data;
            queryClient.setQueriesData<MessagePages>({ queryKey: ['messages', chatJid] }, (old) =>
              patchMessages(
                old,
                (m) => messageIds.includes(m.msgId),
                (m) => ({ ...m, deliveryStatus: status })
              )
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
