import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { post, errorText } from '../../lib/api';
import { Button } from '../../components/ui/button';
import { Field, Input, PasswordInput } from '../../components/ui/form';
import { Alert } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';

// The owner proves control of the deployment with the recovery key, ENCRYPTION_KEY (the app's own inbox can't
// receive a reset link while they're locked out). Other users ask an admin to reset them.
export function RecoverPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/recover', { email, setupKey: key, newPassword: password });
      setDone(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Recover the owner account" subtitle="Members and admins: ask an admin to reset your password." footer={<Link to="/login" className="hover:text-fg">Back to sign in</Link>}>
      {done ? (
        <div className="space-y-4">
          <Alert tone="success" title="Password reset">Two-factor authentication was turned off for the owner account. Sign in and turn it back on in Account settings.</Alert>
          <Button variant="primary" className="w-full justify-center" onClick={() => navigate('/login')}>
            Sign in
          </Button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Owner email" id="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Recovery key" id="key" hint="The key shown once during setup. It is the Worker's ENCRYPTION_KEY secret.">
            <PasswordInput id="key" required value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field label="New password" id="password">
            <PasswordInput id="password" autoComplete="new-password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" className="w-full justify-center" loading={busy}>
            Reset password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
