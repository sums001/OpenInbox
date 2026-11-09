// Sign in (with optional TOTP), sign out, session info, and owner recovery with ENCRYPTION_KEY.
import { Hono } from 'hono';
import type { AppBindings } from '../types';
import { body } from '../lib/validate';
import { loginSchema, recoverSchema, totpSchema } from '../../shared/schemas';
import { isSetupComplete, loadSettings } from '../db/settings';
import { first } from '../db/db';
import { createSession, destroySession, ensureCsrfCookie } from '../auth/session';
import { accountKey, assertNotLimited, clearFailures, clientIpKey, KEY_CHECK_PER_IP, knownLogin, limitedError, limitedFor, LOGIN_PER_ACCOUNT, LOGIN_PER_IP, recordFailure, rememberLogin } from '../auth/rate-limit';
import { clientIp } from '../auth/middleware';
import { DUMMY_HASH, verifyPassword } from '../lib/password';
import { decrypt, safeEqual } from '../lib/crypto';
import { hashRecoveryCode, matchTotpStep } from '../lib/totp';
import { HttpError, unauthorized } from '../lib/errors';
import { parseJson } from '../lib/json';
import { changePassword, invalidLogin, ownerUser, touchLogin, type UserRow } from '../services/users';
import { audit } from '../services/audit';

export const auth = new Hono<AppBindings>();

auth.get('/session', async (c) => {
  ensureCsrfCookie(c);
  const setupComplete = await isSetupComplete(c.env.DB);
  const settings = await loadSettings(c.env.DB);
  const user = c.get('user');
  const session = c.get('session');
  return c.json({
    setupComplete,
    instanceName: settings.instanceName,
    version: __APP_VERSION__,
    storageMode: settings.storageMode,
    remoteImages: settings.remoteImages,
    user: user && session ? { ...user, mfaPending: session.mfaPending } : null,
  });
});

auth.post('/login', async (c) => {
  const { email, password } = await body(c, loginSchema);
  const ip = clientIp(c);
  await assertNotLimited(c.env.DB, clientIpKey('login', ip), LOGIN_PER_IP);
  const user = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE email = ?', email.trim().toLowerCase());
  // The per-account limit stops one password being guessed from many addresses. Networks that
  // have completed a sign-in to the account before are exempt (they still have the per-IP limit),
  // or anyone who knows the address could keep its owner locked out with a few wrong passwords.
  // The lookup runs for unknown addresses too, so timing doesn't tell which accounts exist, and a
  // refusal counts against the per-IP limit.
  const accountWait = await limitedFor(c.env.DB, accountKey('login', email), LOGIN_PER_ACCOUNT);
  if (accountWait !== null && !(await knownLogin(c.env.DB, user?.id ?? 0, ip))) {
    await recordFailure(c.env.DB, clientIpKey('login', ip), LOGIN_PER_IP);
    throw limitedError(accountWait);
  }
  const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || user.status !== 'active') {
    await recordFailure(c.env.DB, clientIpKey('login', ip), LOGIN_PER_IP);
    await recordFailure(c.env.DB, accountKey('login', email), LOGIN_PER_ACCOUNT);
    if (user && ok && user.status !== 'active') throw new HttpError(403, 'disabled', 'This account is disabled. Ask an admin.');
    throw invalidLogin();
  }
  await clearFailures(c.env.DB, accountKey('login', email));
  const mfa = !!user.totp_enabled;
  await createSession(c, user.id, mfa);
  if (!mfa) {
    await touchLogin(c.env.DB, user.id);
    await rememberLogin(c.env.DB, user.id, ip);
    await audit(c.env.DB, { userId: user.id, action: 'auth.login', ip });
  }
  return c.json({ ok: true, mfaRequired: mfa, mustChangePassword: !!user.must_change_password });
});

auth.post('/2fa', async (c) => {
  const { code } = await body(c, totpSchema);
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session?.mfaPending) throw unauthorized();
  const ip = clientIp(c);
  await assertNotLimited(c.env.DB, accountKey('2fa', user.email), LOGIN_PER_ACCOUNT);
  const row = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', user.id);
  let ok = false;
  if (row?.totp_secret) {
    const step = await matchTotpStep(await decrypt(c.env, row.totp_secret), code);
    // Only a step later than the last accepted one; the conditional update also settles two
    // requests racing with the same code.
    if (step !== null) {
      const res = await c.env.DB.prepare('UPDATE users SET totp_last_step = ? WHERE id = ? AND totp_last_step < ?').bind(step, user.id, step).run();
      ok = res.meta.changes > 0;
    }
  }
  if (!ok && row?.recovery_codes) {
    // A recovery code works once: the update only applies to the list as read, so of two
    // requests racing with codes, one wins and the other is refused (and can be tried again).
    const hashes = parseJson<string[]>(row.recovery_codes, []);
    const h = await hashRecoveryCode(code);
    if (hashes.includes(h)) {
      const used = await c.env.DB.prepare('UPDATE users SET recovery_codes = ? WHERE id = ? AND recovery_codes = ?')
        .bind(JSON.stringify(hashes.filter((x) => x !== h)), user.id, row.recovery_codes)
        .run();
      ok = used.meta.changes > 0;
    }
  }
  if (!ok) {
    await recordFailure(c.env.DB, accountKey('2fa', user.email), LOGIN_PER_ACCOUNT);
    throw new HttpError(401, 'invalid_code', 'That code is not valid. Try the current one from your app.');
  }
  await clearFailures(c.env.DB, accountKey('2fa', user.email));
  await c.env.DB.prepare('UPDATE sessions SET mfa_pending = 0 WHERE id = ?').bind(session.id).run();
  await touchLogin(c.env.DB, user.id);
  await rememberLogin(c.env.DB, user.id, ip);
  await audit(c.env.DB, { userId: user.id, action: 'auth.login', details: { mfa: true }, ip });
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

// The app's own inbox is unreachable when the owner is locked out, so the owner proves control
// of the deployment with ENCRYPTION_KEY instead of an emailed link.
auth.post('/recover', async (c) => {
  const { email, setupKey, newPassword } = await body(c, recoverSchema);
  const ip = clientIp(c);
  await assertNotLimited(c.env.DB, clientIpKey('recover', ip), KEY_CHECK_PER_IP);
  const owner = await ownerUser(c.env.DB);
  const keyOk = !!c.env.ENCRYPTION_KEY && (await safeEqual(setupKey.trim(), c.env.ENCRYPTION_KEY));
  if (!owner || !keyOk || owner.email !== email.trim().toLowerCase()) {
    await recordFailure(c.env.DB, clientIpKey('recover', ip), KEY_CHECK_PER_IP);
    throw new HttpError(403, 'recover_failed', 'The owner email or recovery key is wrong.');
  }
  await changePassword(c.env.DB, owner.id, newPassword);
  // So the owner can sign in at once, from wherever they are.
  await clearFailures(c.env.DB, accountKey('login', owner.email));
  await c.env.DB.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, status = ? WHERE id = ?').bind('active', owner.id).run();
  // Recovery assumes the account may have been taken over: API keys made before it stop working.
  await c.env.DB.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(owner.id).run();
  await audit(c.env.DB, { userId: owner.id, action: 'auth.owner_recovered', ip });
  return c.json({ ok: true });
});
