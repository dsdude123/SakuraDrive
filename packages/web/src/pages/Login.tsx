import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client.js';
import type { AuthStatus } from '../App.js';
import { Banner, Field } from '../components/ui.js';

/** Sign-in, or the first-run screen that creates the only account. */
export function LoginPage({
  status,
  onSignedIn,
}: {
  status: AuthStatus;
  onSignedIn: () => void;
}): JSX.Element {
  const setup = status.needsSetup;
  const [username, setUsername] = useState(setup ? 'admin' : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      onSignedIn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="centre-screen">
      <form className="card auth-card" onSubmit={submit}>
        <div className="card-body stack">
          <h1>🌸 SakuraDrive</h1>
          {setup ? (
            <Banner tone="info" title="First run">
              Choose the account you will use to sign in. Everything else — pools, schedule,
              notifications, backups — is configured from the web interface afterwards.
            </Banner>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              Sign in to continue.
            </p>
          )}

          <Field label="Username">
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </Field>

          <Field
            label="Password"
            help={setup ? 'At least 8 characters. Stored as a salted scrypt hash.' : undefined}
          >
            <input
              type="password"
              autoComplete={setup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={setup ? 8 : 1}
            />
          </Field>

          {error && <Banner tone="critical">{error}</Banner>}

          <button className="primary" type="submit" disabled={busy}>
            {busy && <span className="spinner" />}
            {setup ? 'Create account' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
