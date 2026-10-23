// Fetch wrapper: same-origin JSON, CSRF header from the oi_csrf cookie, typed errors.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  return document.cookie.match(/(?:^|;\s*)oi_csrf=([^;]+)/)?.[1] ?? '';
}

type Listener = (e: ApiError) => void;
const listeners = new Set<Listener>();
export function onApiError(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  raw?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (method !== 'GET') headers['X-CSRF-Token'] = csrfToken();
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    credentials: 'same-origin',
    signal: opts.signal,
  });
  if (!res.ok) {
    let payload: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      payload = await res.json();
    } catch {
      // not JSON
    }
    const err = new ApiError(res.status, payload.error?.code ?? 'error', payload.error?.message ?? `Request failed (${res.status})`, payload.error?.details);
    for (const l of listeners) l(err);
    throw err;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'PUT', body });
export const patch = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'PATCH', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
