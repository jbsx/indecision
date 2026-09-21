import { createHmac, scrypt, timingSafeEqual } from "node:crypto";

/**
 * The passphrase gate in front of `serve`. One passphrase for everyone; nothing per-person. A visitor
 * who enters it gets a cookie that proves they did, good for 30 days, after which the server rejects
 * it and the passphrase page comes back.
 */

export const COOKIE_NAME = "indecision";
/** How long an unlock stays good for, in seconds: 30 days. */
export const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Fixed: the key must come out the same across restarts, or every cookie would die with the process. */
const SCRYPT_SALT = "indecision unlock";
const KEY_BYTES = 32;

/** The signing key, derived from the passphrase. Never leaves the process; only signatures with it do. */
export type UnlockKey = Buffer;

/**
 * Stretches the passphrase into the signing key. scrypt, not a plain hash, so a cookie captured off
 * the wire (the transport is plain HTTP) cannot be turned into the passphrase by guessing at hash speed.
 */
export function deriveUnlockKey(passphrase: string): Promise<UnlockKey> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, SCRYPT_SALT, KEY_BYTES, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Whether what was typed into the passphrase box is the passphrase, in constant time. */
export async function isPassphrase(offered: string, key: UnlockKey): Promise<boolean> {
  return sameBytes(await deriveUnlockKey(offered), key);
}

/**
 * The Set-Cookie value for a fresh unlock. The cookie carries its own expiry, signed with the key,
 * so the server enforces the 30 days too, not only the browser. Not `Secure`: the transport is plain
 * HTTP for now, and a Secure cookie would never be sent back.
 */
export function unlockCookie(key: UnlockKey, now: Date): string {
  const expires = Math.floor(now.getTime() / 1000) + COOKIE_MAX_AGE_SECONDS;
  const token = `${expires}.${sign(key, expires)}`;
  return `${COOKIE_NAME}=${token}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`;
}

/** Whether the request's Cookie header carries a cookie this server issued that has not expired. */
export function isUnlocked(cookieHeader: string | undefined, key: UnlockKey, now: Date): boolean {
  const token = readCookie(cookieHeader);
  if (token === undefined) return false;
  const [expiresText, signature, ...rest] = token.split(".");
  if (expiresText === undefined || signature === undefined || rest.length > 0) return false;
  const expires = Number(expiresText);
  if (!Number.isInteger(expires) || expires * 1000 <= now.getTime()) return false;
  return sameBytes(Buffer.from(signature, "utf8"), Buffer.from(sign(key, expires), "utf8"));
}

function sign(key: UnlockKey, expires: number): string {
  return createHmac("sha256", key).update(String(expires)).digest("hex");
}

/** Constant-time comparison. Compares byte lengths first: `timingSafeEqual` throws on a mismatch. */
function sameBytes(a: Buffer, b: Buffer): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function readCookie(header: string | undefined): string | undefined {
  for (const pair of header?.split(";") ?? []) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    if (pair.slice(0, at).trim() === COOKIE_NAME) return pair.slice(at + 1).trim();
  }
  return undefined;
}
