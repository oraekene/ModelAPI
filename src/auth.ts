/**
 * Admin authentication — step 4.
 *
 * Every /admin/* route is guarded by a shared secret carried in the
 * `X-ModelMap-Admin` header.
 *
 * Two properties matter here:
 *
 * 1. The comparison is CONSTANT-TIME. A naive `===` short-circuits on the
 *    first differing byte, which leaks the secret one character at a time to
 *    anyone who can measure response latency. Here, both buffers are always
 *    fully walked.
 *
 * 2. An unset or short (<16 char) secret FAILS CLOSED with a 503. A missing
 *    binding is a misconfiguration, not an invitation to let anyone through.
 */

export type AuthResult =
  | { ok: true }
  | { ok: false; response: Response };

const MIN_SECRET_LENGTH = 16;

export function requireAdmin(req: Request, secret: string | undefined): AuthResult {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, response: new Response('admin secret not configured', { status: 503 }) };
  }

  const got = req.headers.get('X-ModelMap-Admin');
  if (!got) return { ok: false, response: new Response('forbidden', { status: 403 }) };

  const a = new TextEncoder().encode(got);
  const b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }

  return diff === 0 ? { ok: true } : { ok: false, response: new Response('forbidden', { status: 403 }) };
}