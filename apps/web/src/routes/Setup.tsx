import { useState, type SyntheticEvent } from 'react';
import { AuthCard, Alert } from './AuthCard';
import { messageFor, register } from './ceremony';

/** First-run setup: operator name and SETUP_TOKEN, then create the passkey (FR-USR-002). */
export function Setup({ onDone }: { onDone: () => void }) {
  const [displayName, setDisplayName] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register('/setup/options', '/setup/verify', { setupToken, displayName });
      onDone();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Set up Cinewren">
      <Alert message={error} />
      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="setup-name">Your name</label>
          <input
            id="setup-name"
            required
            maxLength={64}
            autoComplete="nickname"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="setup-token">Setup token</label>
          <input
            id="setup-token"
            required
            type="password"
            autoComplete="off"
            value={setupToken}
            onChange={(e) => {
              setSetupToken(e.target.value);
            }}
          />
        </div>
        <button className="button button-primary" type="submit" disabled={busy}>
          {busy ? 'Waiting for your passkey…' : 'Create passkey'}
        </button>
      </form>
      <p className="helper">The setup token is the SETUP_TOKEN secret you set when deploying.</p>
    </AuthCard>
  );
}
