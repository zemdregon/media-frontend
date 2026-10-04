/** Typed functions for the operator operations API: health, audit log, metrics (LLD-API). */
import type { AuditEntry, MetricsSummary, Page, ServerHealth } from '@cinewren/shared';
import { api } from './index';
import { queryString } from './catalog';

export const getServerHealth = (serverId: string, limit = 24) =>
  api<ServerHealth>(
    'GET',
    `/admin/servers/${encodeURIComponent(serverId)}/health${queryString({ limit })}`,
  );

export const listAuditLog = (f: { action?: string; cursor?: string | null; limit?: number }) =>
  api<Page<AuditEntry>>('GET', `/admin/audit-log${queryString({ ...f })}`);

export const getMetrics = (window: '24h' | '7d' = '24h') =>
  api<MetricsSummary>('GET', `/admin/metrics${queryString({ window })}`);
