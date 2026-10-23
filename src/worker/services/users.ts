// Users: the owner claim at setup, admin-created users, and password management.
import type { Env } from '../env';
import { all, first, isUniqueViolation, run } from '../db/db';
import { clearSettingsCache } from '../db/settings';
import { newId } from '../lib/ids';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors';
import { hashPassword, passwordProblem } from '../lib/password';
import { encrypt, randomToken } from '../lib/crypto';
import { createDomain } from './domains';
import { assertAddressFree, mailboxStatements, memberStatement, validateNewAddress } from './mailboxes';
import { auditStmt } from './audit';
import type { Role } from '../../shared/constants';
import type { Cloudflare } from '../cloudflare/client';
import type { SessionUser } from '../types';

export interface UserRow {
  id: number;
  email: string;
  name: string;
  password_hash: string;
  role: Role;
  status: 'active' | 'disabled';
  must_change_password: number;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string | null;
  preferences: string;
  created_at: number;
  last_login_at: number | null;
}

export async function getUser(db: D1Database, id: number): Promise<UserRow> {
  const u = await first<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
  if (!u) throw notFound('User not found.');
  return u;
}

function assertPassword(password: string): void {
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem, 'weak_password');
}

export interface ClaimInput {
  zoneId: string;
  localPart: string;
  displayName: string;
  password: string;
  replaceMx: boolean;
}

// Creates the owner, the domain and the owner's mailbox in one atomic batch. The batch starts by
// inserting setup.completed_at, which fails if setup already happened, so two racing claims
// can't both succeed.
export async function claimInstance(env: Env, cf: Cloudflare, input: ClaimInput, origin: string, ip: string): Promise<{ userId: number; domainId: number }> {
  assertPassword(input.password);
  const zone = await cf.get<{ id: string; name: string; status: string }>(`/zones/${input.zoneId}`);
  const domain = await createDomain(env.DB, zone, input.replaceMx);
  const address = validateNewAddress(input.localPart, domain.name);
  await assertAddressFree(env.DB, address);
  const userId = newId();
  const now = Date.now();
  const { mailboxId, statements } = mailboxStatements(env.DB, {
    domainId: domain.id,
    address,
    displayName: input.displayName.trim(),
  });
  const keyCheck = await encrypt(env, 'openinbox');
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('setup.completed_at', ?, ?)").bind(String(now), now),
      env.DB.prepare(
        "INSERT INTO users (id, email, name, password_hash, role, created_at, last_login_at) VALUES (?, ?, ?, ?, 'owner', ?, ?)",
      ).bind(userId, address, input.displayName.trim(), await hashPassword(input.password), now, now),
      ...statements,
      memberStatement(env.DB, mailboxId, userId, true),
      env.DB.prepare('UPDATE domains SET catch_all_mailbox_id = NULL WHERE id = ?').bind(domain.id),
      env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('app.url', ?, ?), ('crypto.key_check', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).bind(origin, now, keyCheck, now),
      auditStmt(env.DB, { userId, action: 'setup.claimed', target: address, ip }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('This instance has already been set up. Sign in instead.', 'already_setup');
    throw e;
  }
  clearSettingsCache();
  return { userId, domainId: domain.id };
}

export interface UserSummary {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: 'active' | 'disabled';
  totpEnabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  mailboxes: { id: number; address: string; canSend: boolean }[];
}

export async function listUsers(db: D1Database): Promise<UserSummary[]> {
  const users = await all<UserRow>(db, 'SELECT * FROM users ORDER BY role = \'owner\' DESC, name');
  const access = await all<{ user_id: number; mailbox_id: number; address: string; can_send: number }>(
    db,
    'SELECT mm.user_id, mm.mailbox_id, m.address, mm.can_send FROM mailbox_members mm JOIN mailboxes m ON m.id = mm.mailbox_id ORDER BY m.address',
  );
  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    totpEnabled: !!u.totp_enabled,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    mailboxes: access.filter((a) => a.user_id === u.id).map((a) => ({ id: a.mailbox_id, address: a.address, canSend: !!a.can_send })),
  }));
}

export function generatePassword(): string {
  // 16 characters from an unambiguous alphabet.
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

export interface CreateUserInput {
  name: string;
  role: 'admin' | 'member';
  email?: string; // login email when no new mailbox is created
  newMailbox?: { localPart: string; domainId: number } | null;
  mailboxIds?: number[];
  password?: string;
}

export async function createUser(env: Env, actor: SessionUser, input: CreateUserInput, ip: string): Promise<{ id: number; email: string; password: string }> {
  if (input.role === 'admin' && actor.role !== 'owner' && actor.role !== 'admin') throw forbidden();
  const password = input.password || generatePassword();
  assertPassword(password);
  const userId = newId();
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  let email = (input.email ?? '').trim().toLowerCase();

  if (input.newMailbox) {
    const domain = await first<{ id: number; name: string }>(env.DB, 'SELECT id, name FROM domains WHERE id = ?', input.newMailbox.domainId);
    if (!domain) throw notFound('Domain not found.');
    const address = validateNewAddress(input.newMailbox.localPart, domain.name);
    await assertAddressFree(env.DB, address);
    email ||= address;
    const mb = mailboxStatements(env.DB, { domainId: domain.id, address, displayName: input.name.trim() });
    statements.push(...mb.statements, memberStatement(env.DB, mb.mailboxId, userId, true));
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest('Enter a valid login email.');
  for (const mailboxId of input.mailboxIds ?? []) statements.push(memberStatement(env.DB, mailboxId, userId, true));
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO users (id, email, name, password_hash, role, must_change_password, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      ).bind(userId, email, input.name.trim(), await hashPassword(password), input.role, now),
      ...statements,
      auditStmt(env.DB, { userId: actor.id, action: 'user.created', target: email, details: { role: input.role }, ip }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict(`${email} already has an account or is in use.`);
    throw e;
  }
  return { id: userId, email, password };
}

export async function updateUser(
  env: Env,
  actor: SessionUser,
  id: number,
  patch: { name?: string; role?: 'admin' | 'member'; status?: 'active' | 'disabled'; email?: string },
  ip: string,
): Promise<void> {
  const u = await getUser(env.DB, id);
  if (u.role === 'owner' && (patch.role || patch.status === 'disabled')) throw forbidden('The owner cannot be demoted or disabled.');
  if (u.id === actor.id && patch.status === 'disabled') throw forbidden('You cannot disable yourself.');
  const email = patch.email?.trim().toLowerCase() ?? u.email;
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET name = ?, role = ?, status = ?, email = ? WHERE id = ?').bind(
        patch.name?.trim() ?? u.name,
        patch.role ?? u.role,
        patch.status ?? u.status,
        email,
        id,
      ),
      ...(patch.status === 'disabled' ? [env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id)] : []),
      auditStmt(env.DB, { userId: actor.id, action: 'user.updated', target: u.email, details: patch, ip }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict(`${email} is already used by another account.`);
    throw e;
  }
}

export async function resetUserPassword(env: Env, actor: SessionUser, id: number, ip: string): Promise<string> {
  const u = await getUser(env.DB, id);
  if (u.role === 'owner' && actor.id !== u.id) throw forbidden('Only the owner can reset the owner password.');
  const password = generatePassword();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').bind(await hashPassword(password), id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    auditStmt(env.DB, { userId: actor.id, action: 'user.password_reset', target: u.email, ip }),
  ]);
  return password;
}

export async function resetUserTotp(env: Env, actor: SessionUser, id: number, ip: string): Promise<void> {
  const u = await getUser(env.DB, id);
  if (u.role === 'owner' && actor.id !== u.id) throw forbidden('Only the owner can change the owner account.');
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL WHERE id = ?').bind(id),
    auditStmt(env.DB, { userId: actor.id, action: 'user.2fa_reset', target: u.email, ip }),
  ]);
}

export async function deleteUser(env: Env, actor: SessionUser, id: number, reassignTo: number | null, ip: string): Promise<void> {
  const u = await getUser(env.DB, id);
  if (u.role === 'owner') throw forbidden('The owner account cannot be deleted.');
  if (u.id === actor.id) throw forbidden('You cannot delete yourself.');
  const stmts: D1PreparedStatement[] = [];
  if (reassignTo) {
    await getUser(env.DB, reassignTo);
    stmts.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO mailbox_members (mailbox_id, user_id, can_send) SELECT mailbox_id, ?, can_send FROM mailbox_members WHERE user_id = ?',
      ).bind(reassignTo, id),
      env.DB.prepare('UPDATE threads SET assigned_to = ? WHERE assigned_to = ?').bind(reassignTo, id),
    );
  }
  stmts.push(env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id));
  stmts.push(auditStmt(env.DB, { userId: actor.id, action: 'user.deleted', target: u.email, details: { reassignTo }, ip }));
  await env.DB.batch(stmts);
}

export async function changePassword(db: D1Database, userId: number, password: string, keepSessionId?: string): Promise<void> {
  assertPassword(password);
  await db.batch([
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').bind(await hashPassword(password), userId),
    keepSessionId
      ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(userId, keepSessionId)
      : db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ]);
}

export async function ownerUser(db: D1Database): Promise<UserRow | null> {
  return first<UserRow>(db, "SELECT * FROM users WHERE role = 'owner' LIMIT 1");
}

export function invalidLogin(): HttpError {
  return new HttpError(401, 'invalid_login', 'Wrong email or password.');
}

export async function touchLogin(db: D1Database, userId: number): Promise<void> {
  await run(db, 'UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), userId);
}

export { randomToken };
