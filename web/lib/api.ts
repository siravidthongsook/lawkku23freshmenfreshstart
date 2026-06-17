// Typed fetch client. All calls hit the same-origin /api/* proxy (rewrites to backend, cookies preserved).
// Backend error shape: { error: code, message }. We normalize everything to ApiError.

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

const BASE = "/api";

// Parse a Response into T, or throw ApiError using the { error, message } body when present.
async function handle<T>(res: Response): Promise<T> {
  if (res.ok) {
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  let code = "request_failed";
  let message = res.statusText || "Request failed";
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (body.error) code = body.error;
    if (body.message) message = body.message;
  } catch {
    // non-JSON error body (e.g. backend 404/500 while built in parallel) — keep defaults
  }
  throw new ApiError(code, message, res.status);
}

export async function apiGet<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, method: "GET", credentials: "include" });
  return handle<T>(res);
}

export async function apiPost<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handle<T>(res);
}

export async function apiPatch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handle<T>(res);
}

// Multipart upload (files). Do NOT set Content-Type — browser sets the boundary.
export async function apiPostForm<T>(path: string, form: FormData, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    method: "POST",
    credentials: "include",
    body: form,
  });
  return handle<T>(res);
}
