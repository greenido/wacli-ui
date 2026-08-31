import type {
  UnifiedChat,
  UnifiedMessage,
  MissionControlStatus,
  ScheduledMessage,
} from '../types.ts';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3002';

export class ApiClientError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'ApiClientError';
  }
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error: string | null;
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
    try {
      const errorJson = (await response.json()) as ApiResponse<unknown>;
      if (errorJson.error) {
        errorMsg = errorJson.error;
      }
    } catch {
      // ignore
    }
    throw new ApiClientError(errorMsg, response.status);
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

  getMessages: (params: {
    chat: string;
    limit?: number;
    before?: string;
    after?: string;
    asc?: boolean;
  }) =>
    request<{ messages: UnifiedMessage[]; hasMore: boolean }>('/api/messages', {}, params),

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

  starMessage: (data: { chat: string; id: string; starred: boolean }) =>
    request<{ chat: string; id: string; starred: boolean }>('/api/messages/star', {
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
};
