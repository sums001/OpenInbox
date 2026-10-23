import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { post, errorText } from '../../lib/api';
import { useRefreshSession } from '../../lib/session';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/form';
import { Alert } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';

export function TwoFactorPage() {
  const refresh = useRefreshSession();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/2fa', { code });
      await refresh();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title="Two-factor authentication"
      subtitle="Enter the 6-digit code from your authenticator app, or one of your recovery codes."
      footer={
        <button
          type="button"
          className="hover:text-fg"
          onClick={async () => {
            await post('/auth/logout');
            qc.invalidateQueries({ queryKey: ['session'] });
          }}
        >
          Use a different account
        </button>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Code" id="code">
          <Input id="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" className="text-center font-mono text-lg tracking-widest" />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={busy}>
          Verify
        </Button>
      </form>
    </AuthLayout>
  );
}
