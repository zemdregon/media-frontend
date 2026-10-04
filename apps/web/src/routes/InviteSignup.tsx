import { useEffect, useState } from 'react';
import type { InviteInspection } from '@cinewren/shared';
import { api } from '../api-client';
import { AuthCard, Alert } from './AuthCard';
import { messageFor, register } from './ceremony';

const INVALID =
  'This invite link is no longer valid. Ask the person who runs this app for a new one.';

/** Reads the token from the link fragment (`#t=…`), so it never reaches server logs. */
function takeToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
  return token && token.length > 0 ? token : null;
}

export function InviteSignup({ onDone }: { onDone: () => void }) {
  const [token] = useState(takeToken);
  const [invite, setInvite] = useState<InviteInspection | null>(null);
  const [invalid, setInvalid] = useState(token === null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    api<InviteInspection>('POST', '/invites/inspect', { token }).then(setInvite, () => {
      setInvalid(true);
    });
  }, [token]);

  if (invalid) {
    return (
      <AuthCard title="Invite not valid">
        <p>{INVALID}</p>
      </AuthCard>
    );
  }

  const create = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await register('/invites/redeem/options', '/invites/redeem/verify', {
        token,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      window.history.replaceState(null, '', '/');
      onDone();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Join Cinewren">
      <Alert message={error} />
      {invite ? (
        <>
          <p className="helper">You were invited as</p>
          <p className="readonly-name">{invite.displayName}</p>
          <div className="field">
            <label htmlFor="passkey-label">Name your passkey (optional)</label>
            <input
              id="passkey-label"
              maxLength={64}
              placeholder="For example, Work laptop"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
          </div>
          <button
            className="button button-primary"
            type="button"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? 'Waiting for your passkey…' : 'Create passkey'}
          </button>
        </>
      ) : (
        <p className="helper">Checking your invite…</p>
      )}
    </AuthCard>
  );
}
