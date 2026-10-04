import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

function mockFetch(handler: (url: string, init?: RequestInit) => [number, unknown]) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const [status, body] = handler(url, init);
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('shows sign-in when there is no session', async () => {
  mockFetch(() => [
    401,
    { error: { code: 'AUTH_REQUIRED', message: 'Sign in to continue.', requestId: 'r' } },
  ]);
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Use your passkey' })).toBeTruthy();
});

it('shows the account button and signs out from Settings', async () => {
  window.history.replaceState(null, '', '/settings');
  const fetchMock = mockFetch((url) =>
    url.endsWith('/auth/logout')
      ? [204, null]
      : url.endsWith('/me/passkeys')
        ? [200, []]
        : [
            200,
            { id: 'u1', displayName: 'Olivia', role: 'operator', preferences: { theme: 'system' } },
          ],
  );
  render(<App />);
  expect(await screen.findByRole('link', { name: 'Account, Olivia' })).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/v1/auth/logout',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('renders the setup form on /setup', () => {
  window.history.replaceState(null, '', '/setup');
  mockFetch(() => [200, {}]);
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Set up Cinewren' })).toBeTruthy();
  expect(screen.getByLabelText('Setup token')).toBeTruthy();
});

it('shows the invited name from the link fragment, and the error card for a bad invite', async () => {
  window.history.replaceState(null, '', '/invite#t=abcdefghijklmnopqrstuvwxyz');
  const fetchMock = mockFetch(() => [
    200,
    { kind: 'signup', role: 'viewer', displayName: 'Vera', expiresAt: 1 },
  ]);
  render(<App />);
  expect(await screen.findByText('Vera')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/v1/invites/inspect',
    expect.objectContaining({ body: JSON.stringify({ token: 'abcdefghijklmnopqrstuvwxyz' }) }),
  );
  cleanup();

  window.history.replaceState(null, '', '/invite');
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Invite not valid' })).toBeTruthy();
});
