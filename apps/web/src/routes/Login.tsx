import { useState } from 'react';
import { AuthCard, Alert } from './AuthCard';
import { messageFor, signIn } from './ceremony';

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn();
      onSignedIn();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Sign in">
      <Alert message={error} />
      <button
        className="button button-primary"
        type="button"
        disabled={busy}
        onClick={() => void go()}
      >
        {busy ? 'Waiting for your passkey…' : 'Use your passkey'}
      </button>
      <p className="helper">Lost your passkey? Ask the person who invited you for a new link.</p>
    </AuthCard>
  );
}
