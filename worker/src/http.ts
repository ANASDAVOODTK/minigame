import type { ApiErrorBody } from '@minimi/shared';

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra },
  });
}

export function apiError(status: number, error: string, message: string, extra?: Record<string, string>): Response {
  const body: ApiErrorBody = { error, message };
  return json(body, status, extra);
}

/** Reads a small JSON body; returns undefined if missing, too large or malformed. */
export async function readJson(req: Request, maxBytes = 2048): Promise<Record<string, unknown> | undefined> {
  const ct = req.headers.get('content-type') ?? '';
  if (!ct.toLowerCase().includes('application/json')) return undefined;
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > maxBytes) return undefined;
  const text = await req.text();
  if (text.length > maxBytes) return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Blocks cross-site use of the API (CSRF / hot-linking). Same-origin requests are always allowed,
 * requests without an Origin header (curl, health checks) are allowed for GET only.
 */
export function originAllowed(req: Request, url: URL, allowedCsv: string | undefined): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return req.method === 'GET' && req.headers.get('upgrade') === null;
  if (origin === url.origin) return true;
  const allowed = (allowedCsv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes('*') || allowed.includes(origin);
}

export function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
}
