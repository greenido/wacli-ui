import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store/appStore.ts';
import { markChatAsRead } from '../lib/chatRead.ts';
import { sameWhatsAppUser } from '../lib/presence.ts';
import type { MissionControlEvent, MissionControlStatus, UnifiedChat, UnifiedMessage } from '../types.ts';

export function useWebSocket() {
  const queryClient = useQueryClient();
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let shouldReconnect = true;

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

            // 1. Reconcile into active thread messages cache
            queryClient.setQueryData<{ messages: UnifiedMessage[]; hasMore: boolean }>(
              ['messages', newMsg.chatJid],
              (old) => {
                if (!old) return { messages: [newMsg], hasMore: false };
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

            queryClient.setQueriesData<UnifiedChat[]>({ queryKey: ['chats'] }, (old) => {
              if (!old) return old;
              return old.map((c) => {
                if (c.jid !== newMsg.chatJid) return c;

                if (isViewingChat) {
                  if (!newMsg.fromMe) {
                    void markChatAsRead(queryClient, newMsg.chatJid);
                  }
                  return {
                    ...c,
                    lastMessageTs: newMsg.ts,
                    unread: false,
                    unreadCount: 0,
                  };
                }

                // wacli sync already updates unread_count in the store; only bump timestamp here.
                return { ...c, lastMessageTs: newMsg.ts };
              }).sort((a, b) => {
                const tsA = a.lastMessageTs ? new Date(a.lastMessageTs).getTime() : 0;
                const tsB = b.lastMessageTs ? new Date(b.lastMessageTs).getTime() : 0;
                return tsB - tsA;
              });
            });

            if (!isViewingChat && !newMsg.fromMe) {
              queryClient.invalidateQueries({ queryKey: ['chats'] });
            }

            if (!newMsg.fromMe) {
              useAppStore.getState().clearPresence(newMsg.chatJid);
            }
          } else if (payload.type === 'message.receipt') {
            const { chatJid, messageIds, status } = payload.data;
            queryClient.setQueryData<{ messages: UnifiedMessage[]; hasMore: boolean }>(
              ['messages', chatJid],
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
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
          wsRef.current.close();
        }
      }
    };
  }, [queryClient]);

  return { isConnected };
}
