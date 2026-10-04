/**
 * Operator operations contracts (LLD-API; FR-OPS-004, FR-OPS-005, FR-OPS-006, FR-SRV-005,
 * NFR-OBS-002): health view, audit log, metrics, export and credential replacement. Nothing here
 * carries a secret (NFR-SEC-001).
 */
import { z } from 'zod';
import { serverCredentials, type ServerStatus, type ServerType } from './servers';

/** `PUT /admin/servers/{id}/credentials` (FR-SRV-005). */
export const replaceCredentialsRequest = serverCredentials;
export type ReplaceCredentialsRequest = z.input<typeof replaceCredentialsRequest>;

export interface HealthProbe {
  at: number;
  ok: boolean;
  latencyMs: number | null;
  errorCode: string | null;
}

/** `GET /admin/servers/{id}/health` (FR-OPS-004). */
export interface ServerHealth {
  status: ServerStatus;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  /** Newest first. */
  probes: HealthProbe[];
}

export const healthQuery = z.object({
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export interface AuditEntry {
  id: string;
  at: number;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown>;
  requestId: string | null;
}

export const auditQuery = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().trim().min(1).max(64).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});

export const metricsQuery = z.object({ window: z.enum(['24h', '7d']).default('24h') });

/** `GET /admin/metrics` (NFR-OBS-002), computed from D1 (TDD-D4). */
export interface MetricsSummary {
  window: '24h' | '7d';
  since: number;
  sync: {
    serverId: string;
    serverName: string;
    runs: number;
    failed: number;
    partial: number;
    errors: number;
    avgDurationMs: number | null;
    maxDurationMs: number | null;
  }[];
  play: {
    total: number;
    /** Session counts by lifecycle status: authorized, started, ended, expired, failed. */
    outcomes: Record<string, number>;
  };
  /** Selection-mode distribution of the sessions in the window. */
  modes: Record<'direct_play' | 'direct_stream' | 'transcode', number>;
  health: { serverId: string; serverName: string; probes: number; failed: number }[];
}

export interface ExportServer {
  id: string;
  type: ServerType;
  name: string;
  baseUrl: string;
  priority: number;
  libraries: {
    id: string;
    providerLibraryId: string;
    name: string;
    kind: string;
    enabled: boolean;
  }[];
}

/** `GET /admin/export` (FR-OPS-006): primary data only, with no credentials. */
export interface ExportDocument {
  schemaVersion: 1;
  exportedAt: number;
  users: { id: string; displayName: string; role: string; status: string; createdAt: number }[];
  grants: { userId: string; libraryId: string; grantedAt: number }[];
  progress: {
    userId: string;
    mediaItemId: string;
    positionMs: number;
    watched: boolean;
    updatedAt: number;
  }[];
  curationOverrides: {
    id: string;
    kind: string;
    entityKind: string;
    serverId: string;
    providerItemId: string;
    mediaItemId: string | null;
    personId: string | null;
    collectionId: string | null;
    createdAt: number;
  }[];
  servers: ExportServer[];
}
