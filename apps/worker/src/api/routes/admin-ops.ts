import { Hono } from 'hono';
import { auditQuery, healthQuery, metricsQuery } from '@cinewren/shared';
import { parseQuery } from '../../catalog/service';
import * as ops from '../../ops/service';
import * as vault from '../../vault/admin';
import type { AppEnv } from '../context';

/**
 * Operator operations (LLD-API; FR-OPS-004 to FR-OPS-006, NFR-OBS-002, master-key rotation). Mounted
 * under `/api/v1/admin`, so the operator guard has already run. All but `POST /vault/rotate` are GET; none
 * returns a credential (NFR-SEC-001).
 */
export const adminOps = new Hono<AppEnv>()
  .get('/servers/:id/health', async (c) =>
    c.json(await ops.serverHealth(c, c.req.param('id'), parseQuery(c, healthQuery))),
  )
  .get('/audit-log', async (c) => c.json(await ops.auditLog(c, parseQuery(c, auditQuery))))
  .get('/metrics', async (c) => c.json(await ops.metrics(c, parseQuery(c, metricsQuery).window)))
  .get('/vault/status', async (c) => c.json(await vault.status(c)))
  .post('/vault/rotate', async (c) => c.json(await vault.rotate(c), 202))
  .get('/export', async (c) => {
    const body = await ops.exportData(c);
    c.header('Cache-Control', 'no-store');
    c.header(
      'Content-Disposition',
      `attachment; filename="cinewren-export-${new Date(body.exportedAt).toISOString().slice(0, 10)}.json"`,
    );
    return c.json(body);
  });
