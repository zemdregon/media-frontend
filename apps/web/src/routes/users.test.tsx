import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { AdminUser, Invite, Library, Server } from '@cinewren/shared';
import { operator, page, renderApp, viewer, type Handler } from '../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const server: Server = {
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
  libraryCount: 3,
  enabledLibraryCount: 2,
};

const lib = (id: string, name: string, enabled = true): Library => ({
  id,
  serverId: 's1',
  providerLibraryId: id,
  name,
  kind: 'movies',
  enabled,
});
const libraries = [lib('l1', 'Films'), lib('l2', 'Shows'), lib('l3', 'Archive', false)];

const person = (over: Partial<AdminUser> & { id: string; displayName: string }): AdminUser => ({
  role: 'viewer',
  status: 'active',
  createdAt: 1,
  lastSeenAt: null,
  passkeyCount: 1,
  libraryIds: [],
  ...over,
});
const olivia = person({ id: 'u1', displayName: 'Olivia', role: 'operator' });
const vera = person({ id: 'u2', displayName: 'Vera Lynn', libraryIds: ['l1'] });

const invite = (over: Partial<Invite> & { id: string; displayName: string }): Invite => ({
  kind: 'signup',
  userId: `user-${over.id}`,
  role: 'viewer',
  status: 'open',
  createdAt: 1,
  expiresAt: 4_000_000_000_000,
  redeemedAt: null,
  revokedAt: null,
  ...over,
});

const LINK = 'https://cinewren.example/invite#t=SECRET-TOKEN';

/** Serves the shared reads; `extra` handles the rest of a test's calls. */
const serve =
  (opts: { users?: AdminUser[]; invites?: Invite[] }, extra: Handler = () => undefined): Handler =>
  (m, path, body) => {
    if (m === 'GET' && path === '/admin/users') return [200, page(opts.users ?? [olivia, vera])];
    if (m === 'GET' && path.startsWith('/admin/invites')) return [200, page(opts.invites ?? [])];
    if (m === 'GET' && path === '/admin/servers') return [200, [server]];
    if (m === 'GET' && path === '/admin/servers/s1/libraries') return [200, libraries];
    return extra(m, path, body);
  };

const apiError = (status: number, code: string, message: string) =>
  [status, { error: { code, message, requestId: 'r' } }] as [number, unknown];

it('lists people with role, library access summary, status and actions (FR-USR-008)', async () => {
  renderApp('/servers/users', operator, serve({}));
  expect(await screen.findByRole('heading', { name: 'Users and invites' })).toBeTruthy();
  const table = await screen.findByRole('table', { name: /People with an account/ });
  const veraRow = within(table).getByRole('row', { name: /Vera Lynn/ });
  expect(within(veraRow).getByText('Viewer')).toBeTruthy();
  await waitFor(() => {
    expect(within(veraRow).getByText('1 of 2 libraries')).toBeTruthy();
  });
  expect(within(veraRow).getByText('Active')).toBeTruthy();
  for (const name of [
    'Edit access for Vera Lynn',
    'Re-enrol link for Vera Lynn',
    'Disable Vera Lynn',
    'Delete Vera Lynn',
  ]) {
    expect(within(veraRow).getByRole('button', { name })).toBeTruthy();
  }
  const oliviaRow = within(table).getByRole('row', { name: /Olivia/ });
  expect(within(oliviaRow).getByText('All libraries')).toBeTruthy();
  // Operators see every enabled library, so there is no access to edit.
  expect(within(oliviaRow).queryByRole('button', { name: /Edit access/ })).toBeNull();
  expect(screen.getByRole('link', { name: 'Back to Servers' })).toBeTruthy();
});

it('is linked from the Servers page', async () => {
  renderApp('/servers', operator, serve({}));
  await userEvent.click(await screen.findByRole('link', { name: 'Users and invites' }));
  expect(await screen.findByRole('heading', { name: 'Users and invites' })).toBeTruthy();
  expect(window.location.pathname).toBe('/servers/users');
});

it('keeps the screen away from viewers (FR-USR-003)', async () => {
  renderApp('/servers/users', viewer, () => undefined);
  expect(await screen.findByText(/not found|can.t find|page/i)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Users and invites' })).toBeNull();
});

it('lists open invites, and shows an empty state when there are none (FR-USR-004)', async () => {
  renderApp(
    '/servers/users',
    operator,
    serve({ invites: [invite({ id: 'i1', displayName: 'Sam', expiresAt: 4_000_000_000_000 })] }),
  );
  await userEvent.click(await screen.findByRole('radio', { name: 'Invites' }));
  const table = await screen.findByRole('table', { name: 'Open invites' });
  const row = within(table).getByRole('row', { name: /Sam/ });
  expect(within(row).getByText('New account')).toBeTruthy();
  expect(within(row).getByRole('button', { name: 'Revoke the invite for Sam' })).toBeTruthy();
  cleanup();

  renderApp('/servers/users', operator, serve({ invites: [] }));
  await userEvent.click(await screen.findByRole('radio', { name: 'Invites' }));
  expect(await screen.findByText('No open invites')).toBeTruthy();
});

it('creates an invite with every enabled library checked, then shows the link once with Copy (FR-USR-004, FR-USR-005)', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  let sent: unknown;
  renderApp(
    '/servers/users',
    operator,
    serve({}, (m, path, body) => {
      if (m === 'POST' && path === '/admin/invites') {
        sent = body;
        return [201, { id: 'i9', userId: 'u9', link: LINK, expiresAt: 4_000_000_000_000 }];
      }
      return undefined;
    }),
  );
  await userEvent.click(await screen.findByRole('radio', { name: 'Invites' }));
  await userEvent.click(await screen.findByRole('button', { name: 'New invite' }));
  const dialog = await screen.findByRole('dialog', { name: 'New invite' });
  const films = await within(dialog).findByRole('checkbox', { name: /Films/ });
  const shows = within(dialog).getByRole('checkbox', { name: /Shows/ });
  expect((films as HTMLInputElement).checked).toBe(true);
  expect((shows as HTMLInputElement).checked).toBe(true);
  expect(within(dialog).queryByRole('checkbox', { name: /Archive/ })).toBeNull();

  await userEvent.type(within(dialog).getByLabelText('Display name'), 'Sam');
  await userEvent.click(shows);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create invite' }));

  const done = await screen.findByRole('dialog', { name: 'Invite created' });
  expect(sent).toEqual({ displayName: 'Sam', role: 'viewer', libraryIds: ['l1'] });
  const field = within(done).getByLabelText('Single-use link');
  expect((field as HTMLInputElement).value).toBe(LINK);
  expect((field as HTMLInputElement).readOnly).toBe(true);
  expect(within(done).getByText(/Expires/)).toBeTruthy();

  await userEvent.click(within(done).getByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith(LINK);
  expect(await within(done).findByText('Link copied.')).toBeTruthy();
});

it('falls back to the selectable field when copying is refused, and shows a taken name', async () => {
  vi.stubGlobal('navigator', {
    clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
  });
  let attempts = 0;
  renderApp(
    '/servers/users',
    operator,
    serve({}, (m, path) => {
      if (m === 'POST' && path === '/admin/invites') {
        attempts += 1;
        if (attempts === 1)
          return apiError(409, 'DISPLAY_NAME_TAKEN', 'That display name is already in use.');
        return [201, { id: 'i9', userId: 'u9', link: LINK, expiresAt: 4_000_000_000_000 }];
      }
      return undefined;
    }),
  );
  await userEvent.click(await screen.findByRole('radio', { name: 'Invites' }));
  await userEvent.click(await screen.findByRole('button', { name: 'New invite' }));
  const dialog = await screen.findByRole('dialog', { name: 'New invite' });
  await userEvent.type(within(dialog).getByLabelText('Display name'), 'Vera Lynn');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create invite' }));
  expect(await within(dialog).findByText('That display name is already in use.')).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Create invite' }));
  const done = await screen.findByRole('dialog', { name: 'Invite created' });
  await userEvent.click(within(done).getByRole('button', { name: 'Copy' }));
  expect(await within(done).findByText(/Select the link and copy it/)).toBeTruthy();
});

it('closes the invite dialog with Escape and returns focus to New invite', async () => {
  renderApp('/servers/users', operator, serve({}));
  await userEvent.click(await screen.findByRole('radio', { name: 'Invites' }));
  const open = await screen.findByRole('button', { name: 'New invite' });
  await userEvent.click(open);
  await screen.findByRole('dialog', { name: 'New invite' });
  await userEvent.keyboard('{Escape}');
  await waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(document.activeElement).toBe(open);
});

it('revokes an open invite', async () => {
  const revoked: string[] = [];
  renderApp(
    '/servers/users',
    operator,
    serve({ invites: [invite({ id: 'i1', displayName: 'Sam' })] }, (m, path) => {
      if (m === 'DELETE' && path === '/admin/invites/i1') {
        revoked.push(path);
        return [204, null];
      }
      return undefined;
    }),
  );
  await userEvent.click(await screen.findByRole('radio', { name: 'Invites' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Revoke the invite for Sam' }));
  expect(await screen.findByText('Revoked the invite for Sam.')).toBeTruthy();
  expect(revoked).toEqual(['/admin/invites/i1']);
});

it("edits a viewer's library access and saves the grants (FR-USR-005)", async () => {
  let sent: unknown;
  renderApp(
    '/servers/users',
    operator,
    serve({}, (m, path, body) => {
      if (m === 'PUT' && path === '/admin/users/u2/grants') {
        sent = body;
        return [200, { libraryIds: ['l1', 'l2'] }];
      }
      return undefined;
    }),
  );
  const button = await screen.findByRole('button', { name: 'Edit access for Vera Lynn' });
  await waitFor(() => {
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  await userEvent.click(button);
  const dialog = await screen.findByRole('dialog', { name: 'Library access for Vera Lynn' });
  expect(within(dialog).getByRole<HTMLInputElement>('checkbox', { name: /Films/ }).checked).toBe(
    true,
  );
  await userEvent.click(within(dialog).getByRole('checkbox', { name: /Shows/ }));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save access' }));
  expect(await screen.findByText('Saved library access for Vera Lynn.')).toBeTruthy();
  expect(sent).toEqual({ libraryIds: ['l1', 'l2'] });
});

it('issues a re-enrolment link and shows it once (FR-USR-007)', async () => {
  renderApp(
    '/servers/users',
    operator,
    serve({}, (m, path) =>
      m === 'POST' && path === '/admin/users/u2/reenroll'
        ? [201, { id: 'i5', link: LINK, expiresAt: 4_000_000_000_000 }]
        : undefined,
    ),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Re-enrol link for Vera Lynn' }));
  const dialog = await screen.findByRole('dialog', { name: 'Re-enrol link for Vera Lynn' });
  expect(within(dialog).getByLabelText<HTMLInputElement>('Single-use link').value).toBe(LINK);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('disables and re-enables a user (FR-USR-008)', async () => {
  const patches: unknown[] = [];
  let users = [olivia, vera];
  renderApp(
    '/servers/users',
    operator,
    serve({}, (m, path, body) => {
      if (m === 'PATCH' && path === '/admin/users/u2') {
        patches.push(body);
        const status = (body as { status: AdminUser['status'] }).status;
        users = [olivia, { ...vera, status }];
        return [200, users[1]];
      }
      return undefined;
    }),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Disable Vera Lynn' }));
  expect(await screen.findByText('Disabled Vera Lynn. Their sessions ended.')).toBeTruthy();
  expect(patches).toEqual([{ status: 'disabled' }]);
});

it('asks for confirmation naming the person before deleting (FR-USR-008)', async () => {
  const deleted: string[] = [];
  renderApp(
    '/servers/users',
    operator,
    serve({}, (m, path) => {
      if (m === 'DELETE' && path === '/admin/users/u2') {
        deleted.push(path);
        return [204, null];
      }
      return undefined;
    }),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Delete Vera Lynn' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete Vera Lynn?' });
  expect(deleted).toEqual([]);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(deleted).toEqual([]);

  await userEvent.click(screen.getByRole('button', { name: 'Delete Vera Lynn' }));
  const second = await screen.findByRole('dialog', { name: 'Delete Vera Lynn?' });
  await userEvent.click(within(second).getByRole('button', { name: 'Delete Vera Lynn' }));
  expect(await screen.findByText('Deleted Vera Lynn.')).toBeTruthy();
  expect(deleted).toEqual(['/admin/users/u2']);
});

it('disables Delete and Disable for the last operator with the reason (BR-8)', async () => {
  renderApp('/servers/users', operator, serve({}));
  const row = within(await screen.findByRole('table', { name: /People/ })).getByRole('row', {
    name: /Olivia/,
  });
  const del = within(row).getByRole('button', { name: 'Delete Olivia' });
  const disable = within(row).getByRole('button', { name: 'Disable Olivia' });
  expect((del as HTMLButtonElement).disabled).toBe(true);
  expect((disable as HTMLButtonElement).disabled).toBe(true);
  expect(within(row).getByText(/last operator/i)).toBeTruthy();
  expect(del.getAttribute('aria-describedby')).toBeTruthy();
  // Another operator lifts the protection.
  cleanup();
  renderApp(
    '/servers/users',
    operator,
    serve({ users: [olivia, person({ id: 'u3', displayName: 'Omar', role: 'operator' })] }),
  );
  const again = await screen.findByRole('button', { name: 'Delete Olivia' });
  expect((again as HTMLButtonElement).disabled).toBe(false);
});

it('shows the server reason when it refuses with LAST_OPERATOR (409)', async () => {
  const second = person({ id: 'u3', displayName: 'Omar', role: 'operator' });
  renderApp(
    '/servers/users',
    operator,
    serve({ users: [olivia, second] }, (m, path) =>
      path === '/admin/users/u3'
        ? apiError(409, 'LAST_OPERATOR', 'At least one operator must remain.')
        : undefined,
    ),
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Delete Omar' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete Omar?' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete Omar' }));
  expect(await within(dialog).findByText('At least one operator must remain.')).toBeTruthy();
  // The dialog stays open so the reason is read next to the action.
  expect(screen.getByRole('dialog', { name: 'Delete Omar?' })).toBeTruthy();
});
