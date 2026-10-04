/** Typed functions for operator user and invite management (LLD-API; FR-USR-004, FR-USR-005, FR-USR-007, FR-USR-008). */
import type {
  AdminUser,
  CreateInviteRequest,
  CreatedInvite,
  Invite,
  InviteStatus,
  Library,
  Page,
  ReenrollLink,
  Server,
  UpdateUserRequest,
} from '@cinewren/shared';
import { api } from './index';
import { queryString } from './catalog';

const userPath = (id: string) => `/admin/users/${encodeURIComponent(id)}`;

export const listUsers = (cursor?: string | null) =>
  api<Page<AdminUser>>('GET', `/admin/users${queryString({ cursor })}`);

export const listInvites = (f: { status?: InviteStatus; cursor?: string | null }) =>
  api<Page<Invite>>('GET', `/admin/invites${queryString({ ...f })}`);

/** The link in the result is shown once and never stored or logged. */
export const createInvite = (body: CreateInviteRequest) =>
  api<CreatedInvite>('POST', '/admin/invites', body);

export const revokeInvite = (id: string) =>
  api<undefined>('DELETE', `/admin/invites/${encodeURIComponent(id)}`);

export const reenrollUser = (id: string) => api<ReenrollLink>('POST', `${userPath(id)}/reenroll`);

export const updateUser = (id: string, body: UpdateUserRequest) =>
  api<AdminUser>('PATCH', userPath(id), body);

export const deleteUser = (id: string) => api<undefined>('DELETE', userPath(id));

export const setGrants = (id: string, libraryIds: string[]) =>
  api<{ libraryIds: string[] }>('PUT', `${userPath(id)}/grants`, { libraryIds });

/** An enabled library with the name of the server it belongs to, for the access checklist. */
export interface GrantableLibrary extends Library {
  serverName: string;
}

/** Every enabled library across servers (the same endpoints the Servers page uses). */
export async function listEnabledLibraries(): Promise<GrantableLibrary[]> {
  const servers = await api<Server[]>('GET', '/admin/servers');
  const perServer = await Promise.all(
    servers.map(async (s) => {
      const libs = await api<Library[]>(
        'GET',
        `/admin/servers/${encodeURIComponent(s.id)}/libraries`,
      );
      return libs.filter((l) => l.enabled).map((l) => ({ ...l, serverName: s.name }));
    }),
  );
  return perServer.flat();
}
