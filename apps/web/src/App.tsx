import { useCallback, useEffect, useState } from 'react';
import type { Me } from '@cinewren/shared';
import { api } from './api-client';
import { InviteSignup } from './routes/InviteSignup';
import { Login } from './routes/Login';
import { Setup } from './routes/Setup';
import { Shell } from './routes/Shell';

type View = { kind: 'loading' } | { kind: 'signed-out' } | { kind: 'signed-in'; me: Me };

/** SPA shell: setup, invite signup, sign-in, and the signed-in shell (T0.5; full UI in M2). */
export function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [view, setView] = useState<View>({ kind: 'loading' });

  const refresh = useCallback(() => {
    api<Me>('GET', '/me').then(
      (me) => {
        setView({ kind: 'signed-in', me });
      },
      () => {
        setView({ kind: 'signed-out' });
      },
    );
  }, []);

  useEffect(() => {
    if (path !== '/setup' && path !== '/invite') refresh();
  }, [path, refresh]);

  const goHome = () => {
    window.history.replaceState(null, '', '/');
    setPath('/');
  };

  if (path === '/setup') return <Setup onDone={goHome} />;
  if (path === '/invite') return <InviteSignup onDone={goHome} />;
  if (view.kind === 'loading') return <p className="helper">Loading…</p>;
  if (view.kind === 'signed-out') return <Login onSignedIn={refresh} />;
  return (
    <Shell
      me={view.me}
      onSignedOut={() => {
        setView({ kind: 'signed-out' });
      }}
    />
  );
}
