// Attachment storage setup: the bucket step shows done as soon as the bucket exists, before its
// S3 keys are entered.
import { beforeEach, describe, expect, it } from 'vitest';
import { useFakeApis } from '../helpers/fake';
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
});
