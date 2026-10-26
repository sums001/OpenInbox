// The whole product, in order: setup and claim, dashboard, sending provider, users, receiving,
// reading, replying with correct threading headers, search, and member isolation.
// With OI_SCREENSHOTS=1 it also refreshes the README screenshots in docs/screenshots.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const MOCK = 'http://127.0.0.1:8790';
const APP = 'http://localhost:5174';
const PASSWORD = 'correct horse battery staple';
const shots = process.env.OI_SCREENSHOTS === '1';

function encryptionKey(): string {
  try {
    const vars = readFileSync('.dev.vars', 'utf8').match(/^ENCRYPTION_KEY=(.+)$/m);
    if (vars) return vars[1].trim();
  } catch {
    // no .dev.vars (CI): vite.config.ts provides the e2e key
  }
  return 'e2e-encryption-key-0123456789abcdef0123456789';
}

async function shot(page: Page, name: string) {
  if (!shots) return;
  await page.waitForTimeout(500);
  await page.screenshot({ path: `docs/screenshots/${name}.png` });
}

async function deliver(raw: string, from: string, to: string) {
  const res = await fetch(`${APP}/cdn-cgi/handler/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
    method: 'POST',
    body: raw.replace(/\r?\n/g, '\r\n'),
  });
  return res.status;
}

function mail(o: { from: string; to: string; subject: string; body: string; id: string; extra?: string }) {
  return [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${o.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${o.id}>`,
    'Authentication-Results: mx.cloudflare.net; dkim=pass header.d=acme.test; dmarc=pass header.from=acme.test; spf=pass smtp.mailfrom=maya@acme.test',
    ...(o.extra ? [o.extra] : []),
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body,
    '',
  ].join('\n');
}

test.beforeAll(async () => {
  await fetch(`${MOCK}/__mock/reset`);
});

test('setup, send, receive, reply, search and isolate members', async ({ page, browser }) => {
  // 1. Setup: checks, admin email, domain automation.
  await page.goto('/');
  await expect(page.getByText('Welcome to OpenInbox')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled({ timeout: 30_000 });
  await shot(page, 'setup-checks');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('example.com does not receive mail yet')).toBeVisible();
  await page.locator('#name').fill('Sam Owner');
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#confirm').fill(PASSWORD);
  await page.locator('#key').fill('wrong key');
  await page.getByRole('button', { name: 'Create and set up' }).click();
  await expect(page.getByText('not the ENCRYPTION_KEY')).toBeVisible();
  await page.locator('#key').fill(encryptionKey());
  await shot(page, 'setup-admin');
  await page.getByRole('button', { name: 'Create and set up' }).click();
  await expect(page.getByText("You're all set")).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Open the dashboard' }).click();
  await expect(page.getByText('Mail traffic')).toBeVisible();
  await expect(page.getByText('Welcome aboard!')).toBeVisible();

  // 2. Connect Resend: domain registered, DNS written, verified.
  await page.goto('/admin/integrations');
  await page.getByRole('button', { name: /Resend/ }).first().click();
  await page.locator('#apiKey').fill('re_e2e_key');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Resend connected')).toBeVisible();
  await expect(page.getByText('Verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('Verified for sending')).toBeVisible();

  // 3. Add a member with their own inbox.
  await page.goto('/admin/users');
  await page.getByRole('button', { name: 'Add a user' }).click();
  await page.locator('#name').fill('Bob Member');
  await page.locator('#local').fill('bob');
  await page.getByRole('button', { name: 'Add user', exact: true }).click();
  await expect(page.getByText('Share these sign-in details')).toBeVisible();
  const bobPassword = (await page.getByRole('dialog').locator('.font-mono').textContent())!.trim();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText('bob@example.com').first()).toBeVisible();

  // 4. Receive mail, read it, reply.
  expect(await deliver(mail({ from: 'Maya Chen <maya@acme.test>', to: 'admin@example.com', subject: 'Q4 planning agenda', body: 'Can we meet Thursday about the budget?', id: 'q4-1@acme.test' }), 'maya@acme.test', 'admin@example.com')).toBe(200);
  expect(await deliver(mail({ from: 'Maya Chen <maya@acme.test>', to: 'bob@example.com', subject: 'For Bob only', body: 'Private note for Bob.', id: 'bob-1@acme.test' }), 'maya@acme.test', 'bob@example.com')).toBe(200);
  expect(await deliver(mail({ from: 'x@acme.test', to: 'nobody@example.com', subject: 'x', body: 'x', id: 'x@acme.test' }), 'x@acme.test', 'nobody@example.com')).toBe(400);

  await page.goto('/mail/all/inbox');
  await expect(page.getByText('Q4 planning agenda')).toBeVisible();
  await expect(page.getByText('For Bob only')).toHaveCount(0);
  await page.getByText('Q4 planning agenda').click();
  await expect(page.getByText('Can we meet Thursday about the budget?')).toBeVisible();
  await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await page.locator('.ProseMirror').first().click();
  await page.keyboard.type('Thursday works. See you then!');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  // Undo window, then it goes out.
  await expect(page.getByText('Message sent')).toBeVisible({ timeout: 20_000 });
  const state = await (await fetch(`${MOCK}/__mock/state`)).json();
  const sent = state.resend.emails.at(-1);
  expect(sent.to).toEqual(['Maya Chen <maya@acme.test>']);
  expect(sent.subject).toBe('Re: Q4 planning agenda');
  expect(sent.headers['In-Reply-To']).toBe('<q4-1@acme.test>');
  expect(sent.headers.References.split(' ').at(-1)).toBe(sent.headers['Message-ID']);

  // 5. The recipient replies (SES replaced our Message-ID; References still carries it).
  await deliver(
    mail({
      from: 'Maya Chen <maya@acme.test>',
      to: 'admin@example.com',
      subject: 'Re: Q4 planning agenda',
      body: 'Great, booked the room.',
      id: 'q4-2@acme.test',
      extra: `In-Reply-To: <ses-xyz@amazonses.com>\nReferences: <q4-1@acme.test> ${sent.headers['Message-ID']}`,
    }),
    'maya@acme.test',
    'admin@example.com',
  );
  await page.goto('/mail/all/inbox');
  await expect(page.locator('li').filter({ hasText: 'Q4 planning agenda' })).toHaveCount(1);
  await expect(page.locator('li').filter({ hasText: 'Q4 planning agenda' }).getByText('3', { exact: true })).toBeVisible();

  // 6. Search.
  await page.getByPlaceholder('Search mail').fill('booked');
  await page.getByPlaceholder('Search mail').press('Enter');
  await expect(page.getByText('Results for “booked”')).toBeVisible();
  await expect(page.locator('li').filter({ hasText: 'Q4 planning agenda' })).toHaveCount(1);
  await page.goto('/mail/all/inbox');
  await page.goto('/admin');
  await expect(page.getByText('Mail traffic')).toBeVisible();

  // 7. Bob signs in: forced password change, only his inbox, no admin.
  const bobCtx = await browser.newContext();
  const bob = await bobCtx.newPage();
  await bob.goto(`${APP}/login`);
  await bob.locator('#email').fill('bob@example.com');
  await bob.locator('#password').fill(bobPassword);
  await bob.getByRole('button', { name: 'Sign in' }).click();
  await expect(bob.getByText('Choose your password')).toBeVisible();
  await bob.locator('#next').fill('bobs own new password');
  await bob.locator('#confirm').fill('bobs own new password');
  await bob.getByRole('button', { name: 'Save password' }).click();
  await expect(bob.getByText('For Bob only')).toBeVisible();
  await expect(bob.getByText('Q4 planning agenda')).toHaveCount(0);
  await expect(bob.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  const adminApi = await bob.request.get(`${APP}/api/admin/overview`);
  expect(adminApi.status()).toBe(403);
  await bobCtx.close();
});
