import { Hono } from 'hono';
import { auditQuery, healthQuery, metricsQuery } from '@cinewren/shared';
import { parseQuery } from '../../catalog/service';
import * as ops from '../../ops/service';
import type { AppEnv } from '../context';

/**
 * Operator operations reads (LLD-API; FR-OPS-004, FR-OPS-005, FR-OPS-006, NFR-OBS-002). Mounted
 * under `/api/v1/admin`, so the operator guard has already run. All of these are GET and none
 * returns a credential (NFR-SEC-001).
 */
export const adminOps = new Hono<AppEnv>()
  .get('/servers/:id/health', async (c) =>
    c.json(await ops.serverHealth(c, c.req.param('id'), parseQuery(c, healthQuery))),
  )
  .get('/audit-log', async (c) => c.json(await ops.auditLog(c, parseQuery(c, auditQuery))))
  .get('/metrics', async (c) => c.json(await ops.metrics(c, parseQuery(c, metricsQuery).window)))
  .get('/export', async (c) => {
    const body = await ops.exportData(c);
    c.header('Cache-Control', 'no-store');
    c.header(
      'Content-Disposition',
      `attachment; filename="cinewren-export-${new Date(body.exportedAt).toISOString().slice(0, 10)}.json"`,
    );
    return c.json(body);
  });
