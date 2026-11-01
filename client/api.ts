export class ApiError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
}

export async function api<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;

  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  const res = await fetch(path, {
    method,
    credentials: "include",
    headers,
    body,
    signal: options.signal,
  });

  if (res.status === 401 && !path.startsWith("/api/auth/login") && !path.startsWith("/api/auth/register")) {
    window.dispatchEvent(new CustomEvent("sv:unauthorized"));
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let details: unknown;
    try {
      const data = await res.json();
      message = data?.error ?? message;
      details = data?.details;
    } catch {
      /* keep default */
    }
    throw new ApiError(res.status, message, details);
  }

  if (options.raw) return res as unknown as T;
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const http = {
  get: <T = any>(path: string, signal?: AbortSignal) => api<T>(path, { signal }),
  post: <T = any>(path: string, body?: unknown) => api<T>(path, { method: "POST", body }),
  patch: <T = any>(path: string, body?: unknown) => api<T>(path, { method: "PATCH", body }),
  put: <T = any>(path: string, body?: unknown) => api<T>(path, { method: "PUT", body }),
  del: <T = any>(path: string, body?: unknown) => api<T>(path, { method: "DELETE", body }),
  raw: (path: string) => api<Response>(path, { raw: true }),
};

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** Browser helper: resize/compress a photo before uploading. */
export async function prepareImage(
  file: File,
  opts: { maxSize?: number; quality?: number; type?: string } = {},
): Promise<File> {
  const maxSize = opts.maxSize ?? 1600;
  const type = opts.type ?? "image/jpeg";
  if (!file.type.startsWith("image/") || file.type === "image/gif" || file.type === "image/svg+xml") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 1_200_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, opts.quality ?? 0.86));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type });
  } catch {
    return file;
  }
}

export async function imageSize(file: File | Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height };
  } catch {
    return null;
  }
}
