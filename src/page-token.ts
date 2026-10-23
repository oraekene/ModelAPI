/**
 * Page tokens — a bearer credential for the static web app.
 *
 * The mm_user cookie is HttpOnly and SameSite=Strict, so a page on another
 * origin cannot read it. After /link, the browser is redirected to the page
 * with a short signed token in the fragment. The page stores that token and
 * sends it as `Authorization: Bearer ...` to /api/caps.
 *
 * Tokens are stateless: HMAC-SHA256 over `v1.<payload>`, keyed by the admin
 * secret. Rotating the admin secret invalidates every page token.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const USER_ID = /^[\w:.-]{1,64}$/;
const MIN_SECRET_LENGTH = 16;

export const PAGE_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

interface PageTokenPayload {
  u: string;
  e: number;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintPageToken(
  userId: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  if (!USER_ID.test(userId) || secret.length < MIN_SECRET_LENGTH) return null;

  const payload: PageTokenPayload = {
    u: userId,
    e: Math.floor(now / 1000) + PAGE_TOKEN_TTL_SECONDS,
  };
  const body = `v1.${base64url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64url(new Uint8Array(signature))}`;
}

export async function verifyPageToken(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<string | null> {
  if (secret.length < MIN_SECRET_LENGTH) return null;

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  try {
    const body = `${parts[0]}.${parts[1]}`;
    const valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      fromBase64url(parts[2]),
      encoder.encode(body),
    );
    if (!valid) return null;

    const payload = JSON.parse(decoder.decode(fromBase64url(parts[1]))) as Partial<PageTokenPayload>;
    if (!payload || typeof payload.u !== 'string' || !USER_ID.test(payload.u)) return null;
    if (typeof payload.e !== 'number' || !Number.isInteger(payload.e) || payload.e * 1000 <= now) {
      return null;
    }
    return payload.u;
  } catch {
    return null;
  }
}
