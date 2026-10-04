import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../App';

type Handler = (method: string, url: string, body: unknown) => [number, unknown];

function mockApi(handler: Handler) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const [status, payload] = handler(init?.method ?? 'GET', url, body);
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const operator = {
  id: 'u1',
  displayName: 'Olivia',
  role: 'operator',
  preferences: { theme: 'system' },
};

const library = (id: string, name: string, kind: 'movies' | 'tv', enabled = false) => ({
  id,
  serverId: 's1',
  providerLibraryId: `p-${id}`,
  name,
  kind,
  enabled,
});

const server = {
  id: 's1',
  type: 'jellyfin',
  name: 'Basement NAS',
  baseUrl: 'https://media.example.com',
  priority: 0,
  status: 'active',
  version: '12.1.0',
  lastValidatedAt: 1,
  keyVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  libraryCount: 2,
  enabledLibraryCount: 0,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('lists servers on /servers for an operator, with the empty state when there are none', async () => {
  window.history.replaceState(null, '', '/servers');
  mockApi((_m, url) => (url.endsWith('/me') ? [200, operator] : [200, []]));
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Servers' })).toBeTruthy();
  expect(await screen.findByText('No servers yet')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Servers' }).getAttribute('aria-current')).toBe('page');
});

it('asks for a service account username and password, never an API key (UX 8a)', async () => {
  window.history.replaceState(null, '', '/servers');
  mockApi((_m, url) => (url.endsWith('/me') ? [200, operator] : [200, []]));
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
  expect(screen.getByLabelText('Service account username')).toBeTruthy();
  expect(screen.getByLabelText('Password')).toBeTruthy();
  expect(screen.getByLabelText('Server address')).toBeTruthy();
  expect(screen.queryByText(/api key/i)).toBeNull();
  expect(screen.getByText(/non-admin account/i)).toBeTruthy();
});

it('registers a server, then lets the operator enable its libraries', async () => {
  window.history.replaceState(null, '', '/servers');
  const libs = [library('l1', 'Movies', 'movies'), library('l2', 'Shows', 'tv')];
  const fetchMock = mockApi((method, url, body) => {
    if (url.endsWith('/me')) return [200, operator];
    if (method === 'POST' && url.endsWith('/admin/servers')) {
      return [201, { ...server, libraries: libs }];
    }
    if (method === 'PATCH' && url.endsWith('/admin/libraries/l1')) {
      return [200, { ...libs[0], enabled: (body as { enabled: boolean }).enabled }];
    }
    return [200, []];
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Basement NAS' } });
  fireEvent.change(screen.getByLabelText('Server address'), {
    target: { value: 'https://media.example.com' },
  });
  fireEvent.change(screen.getByLabelText('Service account username'), {
    target: { value: 'cinewren-svc' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }));

  expect(await screen.findByText('Basement NAS is connected')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/v1/admin/servers',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        type: 'jellyfin',
        name: 'Basement NAS',
        baseUrl: 'https://media.example.com',
        credentials: { username: 'cinewren-svc', password: 'pw-123' },
      }),
    }),
  );
  // Libraries start disabled, and the page says nothing will be indexed until one is chosen.
  expect(screen.getByText(/nothing will be indexed/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: /Movies/ }));
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/libraries/l1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: true }) }),
    );
  });
  await waitFor(() => {
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /Movies/ }).checked).toBe(true);
  });
});

it('shows the server error message when registration is refused, and keeps the form', async () => {
  window.history.replaceState(null, '', '/servers');
  mockApi((method, url) => {
    if (url.endsWith('/me')) return [200, operator];
    if (method === 'POST') {
      return [
        422,
        {
          error: {
            code: 'SERVER_VALIDATION_FAILED',
            message: 'That account is an administrator. Create a dedicated non-admin account.',
            requestId: 'r',
            details: { check: 'credentials', reason: 'admin_account' },
          },
        },
      ];
    }
    return [200, []];
  });
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add server' }));
  for (const [label, value] of [
    ['Display name', 'NAS'],
    ['Server address', 'https://media.example.com'],
    ['Service account username', 'admin'],
    ['Password', 'x'],
  ] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'Add server' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/administrator/);
  expect(screen.getByLabelText('Service account username')).toBeTruthy();
});

it('shows server cards with status and library counts, and disables a server', async () => {
  window.history.replaceState(null, '', '/servers');
  const fetchMock = mockApi((method, url) => {
    if (url.endsWith('/me')) return [200, operator];
    if (method === 'PATCH') return [200, { ...server, status: 'disabled' }];
    if (url.includes('/health')) {
      return [200, { status: 'active', lastLatencyMs: null, consecutiveFailures: 0, probes: [] }];
    }
    return [200, [server]];
  });
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Basement NAS' })).toBeTruthy();
  expect(screen.getByText('Online')).toBeTruthy();
  expect(screen.getByText('0 of 2 enabled')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Disable Basement NAS' }));
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/admin/servers/s1',
      expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
    );
  });
});

it('hides Servers from a viewer (the server also enforces the role)', async () => {
  window.history.replaceState(null, '', '/servers');
  const fetchMock = mockApi((_m, url) =>
    url.endsWith('/me')
      ? [200, { id: 'u2', displayName: 'Vera', role: 'viewer', preferences: { theme: 'system' } }]
      : [200, { recentlyAdded: [], continueWatching: [] }],
  );
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeTruthy();
  expect(await screen.findByRole('link', { name: 'Account, Vera' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Servers' })).toBeNull();
  expect(fetchMock).not.toHaveBeenCalledWith('/api/v1/admin/servers', expect.anything());
});
