import { useState } from 'react';
import type { Me } from '@cinewren/shared';
import { api } from '../api-client';

/** Signed-in shell: display name and sign-out. The full app arrives in M2 (UX §4). */
export function Shell({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    setBusy(true);
    try {
      await api('POST', '/auth/logout');
    } finally {
      setBusy(false);
      onSignedOut();
    }
  };
  return (
    <>
      <header className="shell-header">
        <p className="wordmark">Cinewren</p>
        <div className="account">
          <span>{me.displayName}</span>
          <span className="role-tag">{me.role}</span>
          <button className="button" type="button" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="shell-main">
        <h1>Welcome, {me.displayName}</h1>
        <p>Browsing and playback arrive in a later release.</p>
      </main>
    </>
  );
}
