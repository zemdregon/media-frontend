/**
 * Server registration contracts (LLD-API "Endpoints", FR-SRV-001 to FR-SRV-003, FR-SRV-007,
 * WF-1). No type here carries a secret: credentials flow in on registration only, and are never
 * returned (NFR-SEC-001).
 */
import { z } from 'zod';

export const SERVER_TYPES = ['jellyfin', 'emby', 'plex'] as const;
export type ServerType = (typeof SERVER_TYPES)[number];

export type ServerStatus =
  'pending_validation' | 'active' | 'degraded' | 'unreachable' | 'disabled' | 'removing';

export type LibraryKind = 'movies' | 'tv';

export const SERVER_NAME_MAX = 64;
export const SERVER_PRIORITY_MAX = 1000;

const serverName = z.string().trim().min(1).max(SERVER_NAME_MAX);
const baseUrl = z.string().trim().min(1).max(2048);
const priority = z.number().int().min(0).max(SERVER_PRIORITY_MAX);

/**
 * Jellyfin and Emby: the username and password of a dedicated non-admin service account
 * (ADR-0008; the spike showed tokens are minted by signing in, so an API key is not enough).
 * Plex: a token for a restricted managed user.
 */
export const serverCredentials = z.union([
  z.strictObject({ username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }),
  z.strictObject({ token: z.string().min(1).max(2048) }),
]);

export const registerServerRequest = z.object({
  type: z.enum(SERVER_TYPES),
  name: serverName,
  baseUrl,
  credentials: serverCredentials,
  priority: priority.optional(),
});

export const updateServerRequest = z
  .object({
    name: serverName.optional(),
    baseUrl: baseUrl.optional(),
    priority: priority.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Nothing to change.',
  });

export const updateLibraryRequest = z.object({ enabled: z.boolean() });

export type RegisterServerRequest = z.input<typeof registerServerRequest>;
export type UpdateServerRequest = z.input<typeof updateServerRequest>;

/** The four FR-SRV-002 checks, in the order they run. */
export type ValidationCheckName = 'tls' | 'credentials' | 'identity' | 'version';

/** `details` of a 422 `SERVER_VALIDATION_FAILED`: names the failed check (FR-SRV-002). */
export interface ServerValidationDetails {
  check: ValidationCheckName;
  reason: string;
  minimumVersion?: string;
}

export interface Library {
  id: string;
  serverId: string;
  providerLibraryId: string;
  name: string;
  kind: LibraryKind;
  enabled: boolean;
}

/** A registered server; never includes credentials. */
export interface Server {
  id: string;
  type: ServerType;
  name: string;
  baseUrl: string;
  priority: number;
  status: ServerStatus;
  version: string | null;
  lastValidatedAt: number | null;
  /** The master-key version protecting this server's credentials (LLD-TOKEN rotation). */
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
  libraryCount: number;
  enabledLibraryCount: number;
}

/** `POST /api/v1/admin/servers` (201) and `GET /api/v1/admin/servers/{id}`. */
export interface ServerDetail extends Server {
  libraries: Library[];
}

/** `POST /api/v1/admin/servers/{id}/validate`. */
export interface ValidationReport {
  ok: true;
  checks: Record<ValidationCheckName, 'passed'>;
  version: string;
}
