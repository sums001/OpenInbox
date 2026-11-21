// Attachment storage setup: the bucket step shows done as soon as the bucket exists, and R2 can be
// turned on with the S3 keys of OpenInbox's own Cloudflare token.
import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { loadSettings } from '../../src/worker/db/settings';
import { decryptJson, sha256Hex } from '../../src/worker/lib/crypto';
import type { R2Config } from '../../src/worker/storage/r2';
import { Client, setupInstance } from '../helpers/client';
import type { FakeState } from '../mock/fake-apis';

describe('attachment storage', () => {
  let fake: { state: FakeState };
  let admin: Client;

  beforeEach(async () => {
    fake = useFakeApis();
    admin = new Client();
    await setupInstance(admin);
  });

  it('lists the buckets, including one it just created', async () => {
    expect(await admin.get('/api/admin/storage')).toMatchObject({ r2Enabled: false, bucketPermission: false, buckets: [] });
    fake.state.r2Enabled = true;
    fake.state.buckets.push('photos');
    expect(await admin.get('/api/admin/storage')).toMatchObject({ r2Enabled: true, bucketPermission: true, configured: false, buckets: ['photos'] });
    await admin.post('/api/admin/storage/bucket', { bucket: 'openinbox-mail' });
    expect((await admin.get('/api/admin/storage')).buckets).toEqual(['photos', 'openinbox-mail']);
  });

  const r2Config = async () => decryptJson<R2Config>(env, (await loadSettings(env.DB, true)).r2Enc!);

  it("turns R2 on with the keys of OpenInbox's own Cloudflare token, which follow a new token", async () => {
    fake.state.r2Enabled = true;
    await admin.post('/api/admin/storage/r2/token', { bucket: 'openinbox-mail' });
    // The bucket is created, and a test object went through R2's S3 API with the token's id.
    expect(fake.state.buckets).toEqual(['openinbox-mail']);
    expect(fake.state.requests.filter((r) => r.url.startsWith('r2/acc_test/openinbox-mail/')).map((r) => [r.method, (r.body as { akid: string }).akid])).toEqual([
      ['PUT', 'tok'],
      ['GET', 'tok'],
      ['DELETE', 'tok'],
    ]);
    expect(await admin.get('/api/admin/storage')).toMatchObject({ mode: 'r2', configured: true, fromToken: true, bucket: 'openinbox-mail' });
    // Access key id: the token's id. Secret: the SHA-256 of the token.
    expect(await r2Config()).toMatchObject({ accessKeyId: 'tok', secretAccessKey: await sha256Hex('test-cf-token'), fromToken: true });
    // Mail with an attachment is kept in R2.
    expect((await admin.post('/api/admin/storage/test')).ok).toBe(true);

    // A token pasted later carries the keys with it.
    admin.envOverride = { CF_API_TOKEN: undefined };
    await admin.post('/api/admin/cloudflare/token', { token: 'valid-token-0123456789abcdef' });
    expect((await r2Config()).secretAccessKey).toBe(await sha256Hex('valid-token-0123456789abcdef'));
  });

  it('says what is missing when the token has no R2 access', async () => {
    fake.state.r2Enabled = true;
    fake.state.s3Keys = [];
    expect(await admin.status('POST', '/api/admin/storage/r2/token', { bucket: 'openinbox-mail' })).toBe(400);
    expect((await admin.get('/api/admin/storage')).configured).toBe(false);
  });
});
