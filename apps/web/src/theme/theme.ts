import type { ThemePreference } from '@cinewren/shared';

/** Per-user theme override (NFR-UX-001, UX §3.5, TDD §6.6). `system` removes the attribute. */
const KEY = 'cw-theme';

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'system' || v === 'dark' || v === 'light';
}

/** Sets `data-theme` on `<html>` and caches the value for the pre-paint script. */
export function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage can be blocked; the account setting still applies on every load.
  }
}
