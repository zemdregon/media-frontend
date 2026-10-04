import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { AuditEntry, Server, ServerHealth } from '@cinewren/shared';
import { operator, page, renderApp, viewer } from '../test-utils';

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
  status: 'degraded',
  version: '12.1.0',
  lastValidatedAt: 1,
  keyVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  libraryCount: 2,
  enabledLibraryCount: 2,
};

const health: ServerHealth = {
  status: 'degraded',
  lastLatencyMs: 41,
  consecutiveFailures: 2,
  probes: [
    { at: 3_000, ok: false, latencyMs: null, errorCode: 'TIMEOUT' },
    { at: 2_000, ok: false, latencyMs: null, errorCode: 'UNAVAILABLE' },
    { at: 1_000, ok: true, latencyMs: 41, errorCode: null },
  ],
};

it('shows each server health on the Servers page: status, latency, failing since and the probe strip (FR-OPS-004)', async () => {
  renderApp('/servers', operator, (_m, path) => {
    if (path === '/admin/servers') return [200, [server]];
    if (path.startsWith('/admin/servers/s1/health')) return [200, health];
    return undefined;
  });
  const panel = await screen.findByRole('region', { name: 'Health of Basement NAS' });
  expect(await within(panel).findByText('Degraded')).toBeTruthy();
  expect(within(panel).getByText(/41 ms from Cinewren/)).toBeTruthy();
  expect(within(panel).getByText(/Failing since/)).toBeTruthy();
  // Oldest first, and every cell has a text alternative (status is not colour only).
  const cells = within(within(panel).getByRole('list', { name: /Recent probes/ })).getAllByRole(
    'listitem',
  );
  expect(cells).toHaveLength(3);
  expect(cells[0]?.textContent).toMatch(/reachable, 41 ms/);
  expect(cells[2]?.textContent).toMatch(/failed \(TIMEOUT\)/);
});

it('says so when a server has no probes yet, and shows nothing for a disabled server', async () => {
  const disabled: Server = { ...server, id: 's2', name: 'Attic', status: 'disabled' };
  renderApp('/servers', operator, (_m, path) => {
    if (path === '/admin/servers') return [200, [{ ...server, status: 'active' }, disabled]];
    if (path.startsWith('/admin/servers/s1/health')) {
      return [200, { status: 'active', lastLatencyMs: null, consecutiveFailures: 0, probes: [] }];
    }
    return undefined;
  });
  expect(await screen.findByText(/No probes yet/)).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Health of Attic' })).toBeNull();
});

const entry = (n: number, action = 'server.update'): AuditEntry => ({
  id: `a${String(n)}`,
  at: 1_800_000_000_000 - n * 1000,
  actorUserId: 'u1',
  action,
  targetType: 'server',
  targetId: `t${String(n)}`,
  details: { fields: ['name'] },
  requestId: `r${String(n)}`,
});

it('lists the audit log newest first, filters by area and pages with Load more (FR-OPS-005)', async () => {
  const seen: string[] = [];
  renderApp('/servers/audit', operator, (_m, path) => {
    if (!path.startsWith('/admin/audit-log')) return undefined;
    seen.push(path);
    if (path.includes('cursor=c2')) return [200, page([entry(3)])];
    if (path.includes('action=user.*')) return [200, page([entry(9, 'user.grants')])];
    return [200, page([entry(1), entry(2)], 'c2')];
  });
  expect(await screen.findByRole('heading', { name: 'Audit log' })).toBeTruthy();
  const table = await screen.findByRole('table', { name: /Operator actions/ });
  expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2
  expect(within(table).getAllByText('server.update')).toHaveLength(2);
  expect(within(table).getAllByText(/fields: \["name"\]/).length).toBeGreaterThan(0);

  await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => {
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

  await userEvent.selectOptions(screen.getByLabelText('Show'), 'user.*');
  expect(await screen.findByText('user.grants')).toBeTruthy();
  expect(seen.some((p) => p.includes('action=user.*'))).toBe(true);
  expect(screen.getByRole('link', { name: 'Back to Servers' })).toBeTruthy();
  const exportLink = screen.getByRole('link', { name: 'Export data' });
  expect(exportLink.getAttribute('href')).toBe('/api/v1/admin/export');
});

it('shows an empty state for a fresh audit log, and keeps the page out of reach of viewers', async () => {
  renderApp('/servers/audit', operator, (_m, path) =>
    path.startsWith('/admin/audit-log') ? [200, page([])] : undefined,
  );
  expect(await screen.findByText('Nothing recorded yet')).toBeTruthy();
  cleanup();
  renderApp('/servers/audit', viewer, () => undefined);
  expect(await screen.findByText(/not found|can.t find|page/i)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Audit log' })).toBeNull();
});
