import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { post, errorText } from '../../lib/api';
import { useRefreshSession, useSession } from '../../lib/session';
import { Button } from '../../components/ui/button';
import { Field, Input, PasswordInput } from '../../components/ui/form';
import { Alert } from '../../components/ui/misc';
import { AuthLayout } from './AuthLayout';

export function LoginPage() {
  const { data: session } = useSession();
  const refresh = useRefreshSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/auth/login', { email, password });
      await refresh();
      const next = params.get('next');
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title={`Sign in to ${session?.instanceName ?? 'OpenInbox'}`} footer={<Link to="/recover" className="hover:text-fg">Owner locked out?</Link>}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Email" id="email">
          <Input id="email" type="email" autoComplete="username" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourdomain.com" />
        </Field>
        <Field label="Password" id="password">
          <PasswordInput id="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full justify-center" size="lg" loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
