/**
 * Auth, setup, invite and passkey contracts (LLD-API; FR-USR-001 to FR-USR-006, ADR-0014).
 * Request bodies are zod schemas so the Worker validates with the same definition the SPA types
 * against. The SPA imports types only.
 */
import { z } from 'zod';

export type Role = 'operator' | 'viewer';
export type ThemePreference = 'system' | 'dark' | 'light';

/** Display-name rule (FRD validation rules: required, trimmed). Length limit: agent decision. */
export const DISPLAY_NAME_MAX = 64;
export const displayName = z.string().trim().min(1).max(DISPLAY_NAME_MAX);

/** WebAuthn credential JSON from `@simplewebauthn/browser`; the library verifies the content. */
const credentialJson = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: z.string().max(4096) }),
});
const challengeId = z.string().min(1).max(64);
const token = z.string().min(16).max(256);
const passkeyLabel = z.string().trim().min(1).max(64);

export const setupOptionsRequest = z.object({ setupToken: z.string().max(512), displayName });
export const setupVerifyRequest = z.object({
  setupToken: z.string().max(512),
  displayName,
  challengeId,
  response: credentialJson,
});
export const inviteTokenRequest = z.object({ token });
export const redeemVerifyRequest = z.object({
  token,
  challengeId,
  response: credentialJson,
  label: passkeyLabel.optional(),
});
export const loginVerifyRequest = z.object({ challengeId, response: credentialJson });
/** `POST /api/v1/me/reauth/verify` (SR-04): an assertion from one of the caller's own passkeys. */
export const reauthVerifyRequest = loginVerifyRequest;
export const passkeyOptionsRequest = z.object({ label: passkeyLabel.optional() });
export const passkeyVerifyRequest = z.object({
  challengeId,
  response: credentialJson,
  label: passkeyLabel.optional(),
});
export const createInviteRequest = z.object({
  displayName,
  role: z.enum(['operator', 'viewer']).default('viewer'),
  libraryIds: z.array(z.string().min(1).max(64)).max(500).optional(),
});
export const inviteStatus = z.enum(['open', 'redeemed', 'expired', 'revoked']);

export type SetupOptionsRequest = z.input<typeof setupOptionsRequest>;
export type CreateInviteRequest = z.input<typeof createInviteRequest>;
export type InviteStatus = z.infer<typeof inviteStatus>;

/** `GET /api/v1/setup`. */
export interface SetupStatus {
  available: boolean;
}

/** Returned by every WebAuthn options endpoint. `options` is WebAuthn JSON for `@simplewebauthn/browser`. */
export interface CeremonyOptions<T = Record<string, unknown>> {
  challengeId: string;
  options: T;
}

export interface UserSummary {
  id: string;
  displayName: string;
  role: Role;
}

/** `GET /api/v1/me`. */
export interface Me extends UserSummary {
  preferences: { theme: ThemePreference };
}

/** `POST /api/v1/me/reauth/verify`: adding a passkey is allowed until `freshUntil` (epoch ms). */
export interface ReauthResult {
  freshUntil: number;
}

export interface PasskeySummary {
  id: string;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

/** `POST /api/v1/invites/inspect`. */
export interface InviteInspection {
  kind: 'signup' | 'reenroll';
  role: Role;
  displayName: string;
  expiresAt: number;
}

/** `POST /api/v1/admin/invites` (201). The link is shown once; only the token hash is stored. */
export interface CreatedInvite {
  id: string;
  userId: string;
  link: string;
  expiresAt: number;
}

/** An entry of `GET /api/v1/admin/invites`; never carries the token. */
export interface Invite {
  id: string;
  kind: 'signup' | 'reenroll';
  userId: string;
  displayName: string;
  role: Role;
  status: InviteStatus;
  createdAt: number;
  expiresAt: number;
  redeemedAt: number | null;
  revokedAt: number | null;
}

/** Cursor page (LLD-API "Pagination"). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
