import type {
  ChatCoverage,
  ConversationExport,
  UnifiedChat,
  UnifiedContact,
  UnifiedGroup,
  UnifiedMessage,
  MissionControlStatus,
  ScheduledMessage,
} from '../types.ts';

const API_BASE =
  import.meta.env.VITE_API_URL ??
  (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3002');

export class ApiClientError extends Error {
  constructor(
    message: string,
    public status?: number,
    public code?: string,
    public lockHolderPid?: number | null
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error: string | null;
  code?: string;
  lockHolderPid?: number | null;
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  params?: Record<string, string | number | boolean | undefined>
): Promise<T> {
  const url = new URL(path, API_BASE);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = new Headers(options.headers);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json');
  }

  const response = await fetch(url.toString(), {
    ...options,
    headers,
  });

  if (!response.ok) {
    let errorMsg = `HTTP Error ${response.status}: ${response.statusText}`;
    let errorCode: string | undefined;
    let lockHolderPid: number | null | undefined;
    try {
      const errorJson = (await response.json()) as ApiResponse<unknown>;
      if (errorJson.error) {
        errorMsg = errorJson.error;
      }
      errorCode = errorJson.code;
      lockHolderPid = errorJson.lockHolderPid;
    } catch {
      // ignore
    }
    throw new ApiClientError(errorMsg, response.status, errorCode, lockHolderPid);
  }

  const body = (await response.json()) as ApiResponse<T>;
  if (!body.success) {
    throw new ApiClientError(body.error || 'API returned unsuccessful result', response.status);
  }

  return body.data;
}

export const api = {
  getHealth: () => request<MissionControlStatus>('/api/health'),

  getMode: () => request<{ readOnly: boolean }>('/api/mode'),

  setMode: (readOnly: boolean) =>
    request<{ readOnly: boolean }>('/api/mode', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify({ readOnly }),
    }),

  getChats: (params?: {
    query?: string;
    limit?: number;
    archived?: boolean;
    pinned?: boolean;
    muted?: boolean;
    unread?: boolean;
  }) => request<UnifiedChat[]>('/api/chats', {}, params),

  markChatRead: (chat: string) =>
    request<{ chat: string; unread: boolean; unreadCount: number }>('/api/chats/mark-read', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify({ chat }),
    }),

  getMessages: (params: {
    chat: string;
    limit?: number;
    before?: string;
    after?: string;
    asc?: boolean;
  }) =>
    request<{ messages: UnifiedMessage[]; hasMore: boolean }>('/api/messages', {}, params),

  /**
   * Everything in one conversation, for keeping or reading elsewhere. Answers
   * with `truncated` rather than quietly handing back a partial history.
   */
  exportConversation: (params: { chat: string; limit?: number; before?: string; after?: string }) =>
    request<ConversationExport>('/api/messages/export', {}, params),

  /** One contact's local metadata, including this machine's own tags. */
  getContact: (params: { jid: string }) =>
    request<UnifiedContact>('/api/contacts/show', {}, params),

  getGroups: (params: { query?: string } = {}) =>
    request<UnifiedGroup[]>('/api/groups', {}, params),

  /**
   * wacli's own local alias for a contact. Written to the wacli store, so safe
   * read-only mode refuses it. An empty alias clears it.
   */
  setContactAlias: (data: { jid: string; alias: string }) =>
    request<{ jid: string; alias: string }>('/api/contacts/alias', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  /** Every tag in use, and which chats carry them. */
  getTags: () =>
    request<{ tags: string[]; byJid: Record<string, string[]> }>('/api/tags'),

  /**
   * Mission Control's own label. wacli can write a tag but has no command that
   * reads one back, so these live here and never leave the host.
   */
  setChatTag: (data: { jid: string; tag: string; add: boolean }) =>
    request<{ jid: string; tags: string[] }>('/api/tags', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  /** How far back the local archive reaches — what the thread can page to. */
  getHistoryCoverage: (params: { chat?: string } = {}) =>
    request<ChatCoverage[]>('/api/history/coverage', {}, params),

  /**
   * Asks the primary device for older messages. This reaches the phone and
   * writes the local store, so safe read-only mode refuses it.
   */
  backfillHistory: (data: { chat: string; count?: number }) =>
    request<{ chat: string; requested: number }>('/api/history/backfill', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  searchMessages: (params: {
    q: string;
    chat?: string;
    limit?: number;
    before?: string;
    after?: string;
    type?: string;
  }) =>
    request<{ query: string; fts: boolean; results: UnifiedMessage[] }>('/api/search', {}, params),

  sendText: (data: { to: string; message: string; replyTo?: string; confirm: boolean }) =>
    request<{ sent: boolean; messageId?: string }>('/api/send/text', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  sendFile: (formData: FormData) =>
    request<{ sent: boolean; messageId?: string }>('/api/send/file', {
      method: 'POST',
      headers: {
        'X-Mission-Control-Request': '1',
      },
      body: formData,
    }),

  sendReact: (data: { to: string; id: string; reaction: string; sender?: string; confirm: boolean }) =>
    request<{ sent: boolean }>('/api/send/react', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  scheduleText: (data: {
    to: string;
    recipientName?: string;
    message: string;
    replyTo?: string;
    scheduledAt: string;
    confirm: boolean;
  }) =>
    request<{ scheduled: boolean; item: ScheduledMessage }>('/api/send/schedule', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  scheduleFile: (formData: FormData) =>
    request<{ scheduled: boolean; item: ScheduledMessage }>('/api/send/schedule-file', {
      method: 'POST',
      headers: {
        'X-Mission-Control-Request': '1',
      },
      body: formData,
    }),

  getScheduled: (params?: { chat?: string }) =>
    request<ScheduledMessage[]>('/api/send/scheduled', {}, params),

  cancelScheduled: (id: string) =>
    request<{ cancelled: boolean }>(`/api/send/scheduled/${id}`, {
      method: 'DELETE',
      headers: {
        'X-Mission-Control-Request': '1',
      },
    }),

  /**
   * Retries a failed scheduled message on the same record. Omit scheduledAt to
   * dispatch immediately; pass one to requeue it for later. The server rejects
   * anything that is not still in the failed state, so a double click cannot
   * put the message out twice.
   */
  resendScheduled: (id: string, data: { scheduledAt?: string } = {}) =>
    request<{ resent: boolean; item: ScheduledMessage }>(`/api/send/scheduled/${id}/resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify({ ...data, confirm: true }),
    }),

  discardScheduled: (id: string) =>
    request<{ discarded: boolean }>(`/api/send/scheduled/${id}/discard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify({}),
    }),

  downloadMedia: (data: { chat: string; id: string }) =>
    request<{ downloaded: boolean; localPath?: string; details?: unknown }>('/api/media/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  getMediaUrl: (params: { chat?: string; id?: string; path?: string; download?: boolean; filename?: string }) => {
    const url = new URL('/api/media/content', API_BASE);
    if (params.chat) url.searchParams.set('chat', params.chat);
    if (params.id) url.searchParams.set('id', params.id);
    if (params.path) url.searchParams.set('path', params.path);
    if (params.download) url.searchParams.set('download', '1');
    if (params.filename) url.searchParams.set('filename', params.filename);
    return url.toString();
  },

  /**
   * Mission Control's own bookmark. Not a WhatsApp star: wacli can read a
   * synced star but has no command to set one, so this never leaves the host.
   */
  bookmarkMessage: (data: { chat: string; id: string; bookmarked: boolean }) =>
    request<{ chat: string; id: string; bookmarked: boolean }>('/api/messages/bookmark', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  getSettings: () =>
    request<{ readOnly: boolean; storeDir?: string; account?: string; currentLogFile?: string }>(
      '/api/settings'
    ),

  updateSettings: (data: { storeDir?: string; account?: string; readOnly?: boolean }) =>
    request<{ readOnly: boolean; storeDir?: string; account?: string }>('/api/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
      body: JSON.stringify(data),
    }),

  restartDaemon: () =>
    request<{ state: string; pid: number | null }>('/api/daemon/restart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
    }),

  startDaemon: () =>
    request<{ state: string; pid: number | null }>('/api/daemon/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
    }),

  stopDaemon: () =>
    request<{ state: string; pid: number | null }>('/api/daemon/stop', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Mission-Control-Request': '1',
      },
    }),
};
