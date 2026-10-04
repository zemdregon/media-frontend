import { useState } from 'react';
import type { Me, ThemePreference } from '@cinewren/shared';
import { savePreferences } from '../api-client/catalog';
import { Alert, PageHead, Segmented } from '../components/ui';
import { applyTheme } from '../theme/theme';
import { errorMessage } from '../lib/useLoad';
import { PasskeysSection } from './Passkeys';

/** Settings: appearance override (NFR-UX-001), own passkeys (FR-USR-006) and account (UX §5). */
export function Settings({
  me,
  onThemeSaved,
  onSignOut,
  signingOut,
}: {
  me: Me;
  onThemeSaved: (t: ThemePreference) => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [theme, setTheme] = useState<ThemePreference>(me.preferences.theme);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (next: ThemePreference) => {
    const previous = theme;
    setTheme(next);
    applyTheme(next);
    setError(null);
    setMessage(null);
    try {
      await savePreferences(next);
      onThemeSaved(next);
      setMessage('Appearance saved.');
    } catch (err) {
      setTheme(previous);
      applyTheme(previous);
      setError(`${errorMessage(err)} Your appearance was not changed.`);
    }
  };

  return (
    <>
      <PageHead title="Settings" />
      <section aria-labelledby="appearance-h" className="stack">
        <h2 id="appearance-h" className="h-section">
          Appearance
        </h2>
        <Segmented<ThemePreference>
          legend="Theme"
          value={theme}
          options={[
            { value: 'system', label: 'System' },
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
          onChange={(v) => void choose(v)}
        />
        <p className="helper">
          System follows your device. Your choice follows you to other browsers.
        </p>
        <Alert message={error} />
        {message && (
          <p className="helper" role="status">
            {message}
          </p>
        )}
      </section>
      <PasskeysSection />
      <section aria-labelledby="account-h" className="stack">
        <h2 id="account-h" className="h-section">
          Account
        </h2>
        <dl className="stats">
          <div>
            <dt>Name</dt>
            <dd>{me.displayName}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd className="mono-value">{me.role}</dd>
          </div>
        </dl>
        <div>
          <button
            type="button"
            className="button button-outline"
            disabled={signingOut}
            onClick={onSignOut}
          >
            Sign out
          </button>
        </div>
      </section>
    </>
  );
}
