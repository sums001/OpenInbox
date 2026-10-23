// PBKDF2-SHA256 password hashing. Workers caps PBKDF2 at 100,000 iterations; Phase 0 measured
// that at about 15 ms CPU, which fits the free plan.
import { fromBase64Url, randomBytes, safeEqual, toBase64Url } from './crypto';

const ITERATIONS = 100_000;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2-sha256$${ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, saltText, hashText] = stored.split('$');
  if (scheme !== 'pbkdf2-sha256' || !iter || !saltText || !hashText) return false;
  const hash = await derive(password, fromBase64Url(saltText), Math.min(Number(iter), ITERATIONS));
  return safeEqual(toBase64Url(hash), hashText);
}

// Verified against when the account doesn't exist, so response timing doesn't reveal it.
export const DUMMY_HASH = 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function passwordProblem(password: string): string | null {
  if (password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 256) return 'Use at most 256 characters.';
  if (/^(.)\1+$/.test(password)) return 'Use more than one repeated character.';
  return null;
}
