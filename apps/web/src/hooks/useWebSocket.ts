import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store/appStore.ts';
import type { MissionControlEvent, UnifiedChat, UnifiedMessage } from '../types.ts';

export function useWebSocket() {
  const queryClient = useQueryClient();
  const setPresence = useAppStore((s) => s.setPresence);
  const selectedChat = useAppStore((s) => s.selectedChat);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let shouldReconnect = true;

    function connect() {
      const wsUrl = import.meta.env.VITE_WS_URL ?? 'ws://127.0.0.1:3002/ws';
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
        ws.close();
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
            queryClient.setQueryData<UnifiedChat[]>(['chats'], (old) => {
              if (!old) return old;
              return old.map((c) => {
                if (c.jid === newMsg.chatJid) {
                  return {
                    ...c,
                    lastMessageTs: newMsg.ts,
                    unread: !newMsg.fromMe,
                    unreadCount: newMsg.fromMe ? c.unreadCount : c.unreadCount + 1,
                  };
                }
                return c;
              }).sort((a, b) => {
                const tsA = a.lastMessageTs ? new Date(a.lastMessageTs).getTime() : 0;
                const tsB = b.lastMessageTs ? new Date(b.lastMessageTs).getTime() : 0;
                return tsB - tsA;
              });
            });
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
            setPresence(chatJid, state, senderJid);
          } else if (payload.type === 'connection.status') {
            queryClient.invalidateQueries({ queryKey: ['health'] });
            if (payload.data.state === 'connected') {
              queryClient.invalidateQueries({ queryKey: ['chats'] });
              if (selectedChat) {
                queryClient.invalidateQueries({ queryKey: ['messages', selectedChat.jid] });
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
        wsRef.current.close();
      }
    };
  }, [queryClient, selectedChat, setPresence]);

  return { isConnected };
}
