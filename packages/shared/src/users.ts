/**
 * User lifecycle, grants and preference contracts (LLD-API; FR-USR-005, FR-USR-007, FR-USR-008,
 * NFR-UX-001, BR-8).
 */
import { z } from 'zod';
import { displayName, type Role, type ThemePreference } from './auth';

export const themePreference = z.enum(['system', 'dark', 'light']);

/** `PATCH /api/v1/me/preferences`. */
export const updatePreferencesRequest = z.object({ theme: themePreference });
export interface Preferences {
  theme: ThemePreference;
}

export const userStatus = z.enum(['invited', 'active', 'disabled']);
export type UserStatus = z.infer<typeof userStatus>;

/** `PATCH /api/v1/admin/users/{id}`; a user can be disabled or re-enabled, not made `invited`. */
export const updateUserRequest = z
  .object({
    role: z.enum(['operator', 'viewer']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    displayName: displayName.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to change.' });

/** `PUT /api/v1/admin/users/{id}/grants`. */
export const grantsRequest = z.object({
  libraryIds: z.array(z.string().min(1).max(64)).max(500),
});

export type UpdateUserRequest = z.input<typeof updateUserRequest>;

/** An entry of `GET /api/v1/admin/users`. */
export interface AdminUser {
  id: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  createdAt: number;
  lastSeenAt: number | null;
  passkeyCount: number;
  /** Granted libraries; always empty for operators, who see every enabled library. */
  libraryIds: string[];
}

/** `POST /api/v1/admin/users/{id}/reenroll` (201). The link is shown once. */
export interface ReenrollLink {
  id: string;
  link: string;
  expiresAt: number;
}
