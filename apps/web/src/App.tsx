import { useCallback, useEffect, useState } from 'react';
import type { Me, ThemePreference } from '@cinewren/shared';
import { api } from './api-client';
import { RouterProvider, useRouter } from './lib/router';
import { InviteSignup } from './routes/InviteSignup';
import { Login } from './routes/Login';
import { Setup } from './routes/Setup';
import { Shell } from './routes/Shell';
import { applyTheme } from './theme/theme';

type View = { kind: 'loading' } | { kind: 'signed-out' } | { kind: 'signed-in'; me: Me };

/** SPA root: setup, invite signup, sign-in, and the signed-in shell. */
export function App() {
  return (
    <RouterProvider>
      <Root />
    </RouterProvider>
  );
}

function Root() {
  const { location, navigate } = useRouter();
  const path = location.path;
  const [view, setView] = useState<View>({ kind: 'loading' });

  const refresh = useCallback(() => {
    api<Me>('GET', '/me').then(
      (me) => {
        applyTheme(me.preferences.theme);
        setView({ kind: 'signed-in', me });
      },
      () => {
        setView({ kind: 'signed-out' });
      },
    );
  }, []);

  // Load the account when entering or leaving the setup and invite screens, not on every route.
  const authScreen = path === '/setup' || path === '/invite';
  useEffect(() => {
    if (!authScreen) refresh();
  }, [authScreen, refresh]);

  const goHome = () => {
    navigate('/', { replace: true });
  };

  if (path === '/setup') return <Setup onDone={goHome} />;
  if (path === '/invite') return <InviteSignup onDone={goHome} />;
  if (view.kind === 'loading') return <p className="helper centered-note">Loading…</p>;
  if (view.kind === 'signed-out') return <Login onSignedIn={refresh} />;
  return (
    <Shell
      me={view.me}
      onSignedOut={() => {
        navigate('/', { replace: true });
        setView({ kind: 'signed-out' });
      }}
      onThemeSaved={(theme: ThemePreference) => {
        setView({ kind: 'signed-in', me: { ...view.me, preferences: { theme } } });
      }}
    />
  );
}
