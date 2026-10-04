// T2.11: the per-user theme override (NFR-UX-001) applies at once, persists through
// PATCH /me/preferences, and rolls back when saving fails.
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { renderApp, viewer } from '../test-utils';

it('applies the saved preference when the account loads', async () => {
  renderApp('/settings', { ...viewer, preferences: { theme: 'light' } }, () => undefined);
  expect(await screen.findByRole('radio', { name: 'Light' })).toBeChecked();
  expect(document.documentElement.dataset.theme).toBe('light');
});

it('choosing Dark sets data-theme, caches it and PATCHes the preference', async () => {
  const fetchMock = renderApp('/settings', viewer, (m, p, body) =>
    m === 'PATCH' && p === '/me/preferences' ? [200, body] : undefined,
  );
  const group = await screen.findByRole('group', { name: 'Theme' });
  expect(group).toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'Dark' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem('cw-theme')).toBe('dark');
  expect(await screen.findByText('Appearance saved.')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/v1/me/preferences',
    expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ theme: 'dark' }) }),
  );
});

it('System removes the override', async () => {
  renderApp('/settings', { ...viewer, preferences: { theme: 'dark' } }, (m, _p, body) =>
    m === 'PATCH' ? [200, body] : undefined,
  );
  await userEvent.click(await screen.findByRole('radio', { name: 'System' }));
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  expect(localStorage.getItem('cw-theme')).toBeNull();
});

it('rolls back and explains when the preference cannot be saved', async () => {
  renderApp('/settings', viewer, (m) =>
    m === 'PATCH'
      ? [500, { error: { code: 'INTERNAL', message: 'Something went wrong.', requestId: 'r' } }]
      : undefined,
  );
  await userEvent.click(await screen.findByRole('radio', { name: 'Light' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your appearance was not changed.');
  expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
  expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
});
