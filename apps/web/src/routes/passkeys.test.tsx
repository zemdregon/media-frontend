// T5.8 SR-04: Settings → Passkeys. "Add passkey" first confirms it's the user with an existing
// passkey (POST /me/reauth/*), then registers the new one (POST /me/passkeys/*); cancel and
// errors stop before anything is saved (FR-USR-006, UX §5).
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { PasskeySummary } from '@cinewren/shared';
import { renderApp, viewer, type Handler } from '../test-utils';

const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
vi.mock('@simplewebauthn/browser', () => webauthn);

const phone: PasskeySummary = {
  id: 'pk1',
  label: 'Phone',
  createdAt: Date.UTC(2026, 8, 1),
  lastUsedAt: null,
  backedUp: true,
};
const laptop: PasskeySummary = { ...phone, id: 'pk2', label: 'Laptop' };
const ok = (over: Record<string, unknown> = {}) => ({ id: 'cred', rawId: 'cred', ...over });

beforeEach(() => {
  webauthn.startAuthentication.mockReset().mockResolvedValue(ok({ kind: 'assertion' }));
  webauthn.startRegistration.mockReset().mockResolvedValue(ok({ kind: 'attestation' }));
});

/** A passkey API with a mutable list; `extra` answers first. */
function passkeyApi(list: PasskeySummary[], extra: Handler = () => undefined): Handler {
  return (m, p, body) => {
    const r = extra(m, p, body);
    if (r) return r;
    if (m === 'GET' && p === '/me/passkeys') return [200, list];
    if (m === 'POST' && p === '/me/reauth/options')
      return [200, { challengeId: 'ra', options: {} }];
    if (m === 'POST' && p === '/me/reauth/verify') return [200, { freshUntil: Date.now() + 1 }];
    if (m === 'POST' && p === '/me/passkeys/options')
      return [200, { challengeId: 'reg', options: {} }];
    if (m === 'POST' && p === '/me/passkeys/verify') {
      list.push(laptop);
      return [201, { passkey: laptop }];
    }
    return undefined;
  };
}

const calls = (fetchMock: ReturnType<typeof renderApp>) =>
  fetchMock.mock.calls
    .map(([url, init]) => `${init?.method ?? 'GET'} ${url.replace('/api/v1', '')}`)
    .filter((c) => c.includes('/me/reauth') || c.includes('/me/passkeys/'));

it('lists passkeys and explains why the only one cannot be removed', async () => {
  renderApp('/settings', viewer, passkeyApi([phone]));
  expect(await screen.findByText('Phone')).toBeInTheDocument();
  const remove = screen.getByRole('button', { name: 'Remove' });
  expect(remove).toBeDisabled();
  expect(remove).toHaveAccessibleDescription(
    "Add another passkey first. You can't remove your only one.",
  );
});

it('Add passkey confirms it is you first, then registers the new passkey', async () => {
  const fetchMock = renderApp('/settings', viewer, passkeyApi([phone]));
  await userEvent.type(await screen.findByLabelText('Name your new passkey (optional)'), 'Laptop');
  await userEvent.click(screen.getByRole('button', { name: 'Add passkey' }));
  expect(await screen.findByText('Laptop added.')).toBeInTheDocument();
  expect(calls(fetchMock)).toEqual([
    'POST /me/reauth/options',
    'POST /me/reauth/verify',
    'POST /me/passkeys/options',
    'POST /me/passkeys/verify',
  ]);
  expect(webauthn.startAuthentication).toHaveBeenCalledBefore(webauthn.startRegistration);
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/v1/me/reauth/verify',
    expect.objectContaining({
      body: JSON.stringify({ challengeId: 'ra', response: ok({ kind: 'assertion' }) }),
    }),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/v1/me/passkeys/verify',
    expect.objectContaining({
      body: JSON.stringify({
        label: 'Laptop',
        challengeId: 'reg',
        response: ok({ kind: 'attestation' }),
      }),
    }),
  );
  // The list reloads with the new passkey; now either one can be removed.
  await waitFor(() => {
    expect(screen.getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });
  expect(screen.getAllByRole('button', { name: 'Remove' })[0]).toBeEnabled();
});

it('cancelling the confirm step stops before registration and saves nothing', async () => {
  webauthn.startAuthentication.mockRejectedValue(
    Object.assign(new Error('The operation was cancelled.'), { name: 'NotAllowedError' }),
  );
  const fetchMock = renderApp('/settings', viewer, passkeyApi([phone]));
  await userEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
  expect(await screen.findByText('Passkey step cancelled. Nothing was saved.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(calls(fetchMock)).toEqual(['POST /me/reauth/options']);
  expect(webauthn.startRegistration).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Add passkey' })).toBeEnabled();
});

it('a refused confirmation shows the error and does not register', async () => {
  const fetchMock = renderApp(
    '/settings',
    viewer,
    passkeyApi([phone], (m, p) =>
      m === 'POST' && p === '/me/reauth/verify'
        ? [
            400,
            {
              error: {
                code: 'WEBAUTHN_VERIFICATION_FAILED',
                message: "Passkey step didn't finish. Nothing was saved. Try again.",
                requestId: 'r',
              },
            },
          ]
        : undefined,
    ),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
  expect(await screen.findByRole('alert')).toHaveTextContent("Passkey step didn't finish.");
  expect(calls(fetchMock)).toEqual(['POST /me/reauth/options', 'POST /me/reauth/verify']);
  expect(webauthn.startRegistration).not.toHaveBeenCalled();
});

it('cancelling the new passkey prompt after confirming saves nothing', async () => {
  webauthn.startRegistration.mockRejectedValue(
    Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }),
  );
  const fetchMock = renderApp('/settings', viewer, passkeyApi([phone]));
  await userEvent.click(await screen.findByRole('button', { name: 'Add passkey' }));
  expect(await screen.findByText('Passkey step cancelled. Nothing was saved.')).toBeInTheDocument();
  expect(calls(fetchMock)).not.toContain('POST /me/passkeys/verify');
});

it('Remove asks for confirmation, then deletes the passkey', async () => {
  const list = [phone, laptop];
  const fetchMock = renderApp(
    '/settings',
    viewer,
    passkeyApi(list, (m, p) => {
      if (m === 'DELETE' && p === '/me/passkeys/pk2') {
        list.splice(1, 1);
        return [204, null];
      }
      return undefined;
    }),
  );
  await screen.findByText('Laptop');
  await userEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1] as HTMLElement);
  expect(
    screen.getByText('Remove Laptop? Any session signed in with it ends.'),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Remove Laptop' }));
  expect(
    await screen.findByText('Laptop removed. Sessions signed in with it have ended.'),
  ).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/v1/me/passkeys/pk2',
    expect.objectContaining({ method: 'DELETE' }),
  );
  await waitFor(() => {
    expect(screen.queryByText('Laptop')).toBeNull();
  });
});
