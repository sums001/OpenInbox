import { useState, type FormEvent } from 'react';
import { post, errorText } from '../../lib/api';
import { useRefreshSession } from '../../lib/session';
import { Button } from '../../components/ui/button';
import { Field, PasswordInput } from '../../components/ui/form';
import { Alert } from '../../components/ui/misc';
import { PasswordStrength } from '../../components/PasswordStrength';
import { AuthLayout } from './AuthLayout';

export function ChangePasswordPage({ forced }: { forced?: boolean }) {
  const refresh = useRefreshSession();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    setError('');
    try {
      await post('/account/password', { next });
      await refresh();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Choose your password" subtitle={forced ? 'Your account was created with a temporary password. Pick your own to continue.' : undefined}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="New password" id="next" hint="At least 10 characters. A short sentence works well.">
          <PasswordInput id="next" autoComplete="new-password" autoFocus required value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <PasswordStrength password={next} />
        <Field label="Confirm password" id="confirm">
          <PasswordInput id="confirm" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={busy}>
          Save password
        </Button>
      </form>
    </AuthLayout>
  );
}
