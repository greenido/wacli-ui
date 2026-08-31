import type {
  UnifiedChat,
  UnifiedMessage,
  MissionControlStatus,
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
