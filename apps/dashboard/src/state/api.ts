/** Thin REST helpers. Every action returns quickly; the WebSocket delivers the resulting state. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
    readonly status = 0,
  ) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, data?.details ?? [], res.status);
  return data as T;
}

export const api = {
  get: <T>(url: string) => req<T>('GET', url),
  post: <T = { ok: boolean }>(url: string, body: unknown = {}) => req<T>('POST', url, body),
  put: <T = { ok: boolean }>(url: string, body: unknown) => req<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => req<T>('PATCH', url, body),
  del: <T = { ok: boolean }>(url: string) => req<T>('DELETE', url),
};
