/**
 * The shared MediaProvider contract suite (T1.2, IR-002, NFR-MAINT-001). One suite runs against
 * any adapter: the adapter's test file supplies a `ContractSpec` that points at its recorded
 * fixtures, and the harness drives the adapter through the real origin-fetch wrapper over a
 * fixture-backed fake `fetch`. Everything here is provider-neutral; adapter-specific facts
 * (IDs, counts, which fixture answers which request) live in the spec.
 */
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../../src/providers/errors';
import { buildProviderContext } from '../../src/providers/registry';
import type {
  MediaProvider,
  NormalizedItem,
  NormalizedLibrary,
  ProviderContext,
  ProviderType,
  ServerSecret,
  ValidationResult,
} from '../../src/providers/types';
import {
  createFakeOrigin,
  type FakeOrigin,
  type FakeOriginOptions,
  type Route,
} from './fixture-fetch';

export interface ContractSpec {
  name: string;
  provider: MediaProvider;
  type: ProviderType;
  /** Folder name under `test-fixtures/providers/`. */
  fixtureDir: string;
  baseUrl: string;
  secret: ServerSecret;
  /** Routes answering validate, listLibraries, listItems (all pages) and getItem. */
  happy: Route[];
  expected: {
    originServerId: string;
    version: string;
    libraries: NormalizedLibrary[];
    paged: { libraryId: string; pageSize: number; total: number; pages: number };
    /** A "changed since" request; proves the filter is applied (spike: unknown params are ignored). */
    since: { libraryId: string; since: number; routes: Route[]; count: number };
    item: {
      id: string;
      title: string;
      externalIds: NormalizedItem['externalIds'];
      minCredits: number;
    };
    /** Synthetic 404 (no recording exists for an unknown item). */
    unknownItem: { id: string; routes: Route[] };
  };
  /** Route sets that make `validate` fail at a specific check. */
  failures: {
    badCredentials: Route[];
    adminAccount: Route[];
    notAServer: Route[];
    versionTooOld: Route[];
  };
}

function expectValidItem(item: NormalizedItem): void {
  expect(item.providerItemId).toBeTruthy();
  expect(['movie', 'series', 'season', 'episode']).toContain(item.type);
  expect(item.title).toBeTruthy();
  expect(Array.isArray(item.genres)).toBe(true);
  for (const [scheme, value] of Object.entries(item.externalIds)) {
    expect(['tmdb', 'imdb', 'tvdb']).toContain(scheme);
    expect(typeof value).toBe('string');
  }
  if (item.type === 'series' || item.type === 'season') expect(item.versions).toEqual([]);
  if (item.type === 'season' || item.type === 'episode') expect(item.credits).toEqual([]);
  if (item.type === 'movie' || item.type === 'episode') {
    expect(item.versions.length).toBeGreaterThan(0);
  }
  for (const v of item.versions) {
    expect(v.providerVersionId).toBeTruthy();
    expect(['none', 'hdr10', 'hdr10plus', 'hlg', 'dolby_vision']).toContain(v.hdr);
    expect(v.sizeBytes === undefined || v.sizeBytes >= 0).toBe(true);
    for (const t of v.subtitles) expect(['text', 'image']).toContain(t.kind);
  }
  item.credits.forEach((c, i) => {
    expect(c.order).toBe(i);
    expect(c.person.providerPersonId).toBeTruthy();
    expect(c.person.name).toBeTruthy();
    expect(['actor', 'director', 'writer', 'producer', 'other']).toContain(c.role);
  });
  expect(item.credits.length).toBeLessThanOrEqual(40);
  // An unreliable ID must never be invented (LLD-PROV): only known schemes, only strings.
  for (const c of item.credits) {
    expect(Object.keys(c.person.externalIds).every((k) => k === 'tmdb' || k === 'imdb')).toBe(true);
  }
}

export function runProviderContract(spec: ContractSpec): void {
  const host = new URL(spec.baseUrl).host;

  function setup(
    routes: Route[],
    options: FakeOriginOptions = {},
    originServerId?: string,
  ): { ctx: ProviderContext; origin: FakeOrigin } {
    const origin = createFakeOrigin(spec.fixtureDir, routes, options);
    const ctx = buildProviderContext({
      server: {
        id: 'srv_test',
        type: spec.type,
        baseUrl: new URL(spec.baseUrl),
        ...(originServerId ? { originServerId } : {}),
      },
      secret: spec.secret,
      fetchImpl: origin.fetch,
    });
    return { ctx, origin };
  }

  function expectNoStrayRequests(origin: FakeOrigin): void {
    expect(origin.unmatched).toEqual([]);
    expect(origin.calls.length).toBeGreaterThan(0);
    // NFR-SEC-005: every outbound request goes to the registered host, and none follows a redirect itself.
    for (const call of origin.calls) {
      expect(call.url.host).toBe(host);
      expect(call.redirect).toBe('manual');
    }
  }

  async function failure(routes: Route[]): Promise<ValidationResult> {
    const { ctx, origin } = setup(routes);
    const result = await spec.provider.validate(ctx);
    expect(origin.unmatched).toEqual([]);
    return result;
  }

  describe(`MediaProvider contract: ${spec.name}`, () => {
    it('declares its type', () => {
      expect(spec.provider.type).toBe(spec.type);
    });

    describe('validate (FR-SRV-002)', () => {
      it('passes the four checks and returns the origin server ID and version', async () => {
        const { ctx, origin } = setup(spec.happy);
        const result = await spec.provider.validate(ctx);
        expect(result).toMatchObject({
          ok: true,
          originServerId: spec.expected.originServerId,
          version: spec.expected.version,
        });
        expectNoStrayRequests(origin);
      });

      it('fails the credentials check for rejected credentials', async () => {
        expect(await failure(spec.failures.badCredentials)).toEqual({
          ok: false,
          check: 'credentials',
          reason: 'invalid_credentials',
        });
      });

      it('refuses an administrator account (ADR-0008)', async () => {
        expect(await failure(spec.failures.adminAccount)).toEqual({
          ok: false,
          check: 'credentials',
          reason: 'admin_account',
        });
      });

      it('fails the identity check when the host is not this kind of server', async () => {
        expect(await failure(spec.failures.notAServer)).toEqual({
          ok: false,
          check: 'identity',
          reason: 'not_a_server',
        });
      });

      it('fails the identity check on re-validation when the server ID changed', async () => {
        const { ctx } = setup(spec.happy, {}, 'some-other-server-id');
        expect(await spec.provider.validate(ctx)).toEqual({
          ok: false,
          check: 'identity',
          reason: 'server_id_mismatch',
        });
      });

      it('fails the version check below the minimum', async () => {
        const result = await failure(spec.failures.versionTooOld);
        expect(result).toMatchObject({ ok: false, check: 'version', reason: 'version_too_old' });
      });

      it('fails the tls check when the host is unreachable', async () => {
        const { ctx } = setup(spec.happy, { unreachable: true });
        expect(await spec.provider.validate(ctx)).toEqual({
          ok: false,
          check: 'tls',
          reason: 'unreachable',
        });
      });

      it('refuses a redirect to another host and never contacts it (NFR-SEC-005)', async () => {
        const { ctx, origin } = setup(spec.happy, { redirectTo: 'https://evil.example/steal' });
        expect(await spec.provider.validate(ctx)).toEqual({
          ok: false,
          check: 'tls',
          reason: 'redirect_refused',
        });
        expect(origin.calls.map((c) => c.url.host)).toEqual([host]);
      });
    });

    describe('listLibraries (FR-SRV-003)', () => {
      it('returns only movie and TV libraries, normalized', async () => {
        const { ctx, origin } = setup(spec.happy);
        expect(await spec.provider.listLibraries(ctx)).toEqual(spec.expected.libraries);
        expectNoStrayRequests(origin);
      });
    });

    describe('listItems (FR-SYNC-003)', () => {
      it('pages through a library with an opaque cursor and returns every item once', async () => {
        const { ctx, origin } = setup(spec.happy);
        const { libraryId, pageSize, total, pages } = spec.expected.paged;
        const seen: NormalizedItem[] = [];
        let cursor: string | undefined;
        let pageCount = 0;
        do {
          const page = await spec.provider.listItems(ctx, {
            libraryId,
            pageSize,
            ...(cursor === undefined ? {} : { cursor }),
          });
          expect(page.items.length).toBeLessThanOrEqual(pageSize);
          seen.push(...page.items);
          pageCount++;
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined && pageCount < 20);
        expect(pageCount).toBe(pages);
        expect(seen).toHaveLength(total);
        expect(new Set(seen.map((i) => i.providerItemId)).size).toBe(total);
        seen.forEach(expectValidItem);
        expectNoStrayRequests(origin);
      });

      it('applies the "changed since" filter', async () => {
        const { libraryId, since, routes, count } = spec.expected.since;
        const { ctx, origin } = setup(routes);
        const page = await spec.provider.listItems(ctx, { libraryId, pageSize: 50, since });
        expect(page.items).toHaveLength(count);
        expect(page.nextCursor).toBeNull();
        page.items.forEach(expectValidItem);
        expectNoStrayRequests(origin);
      });

      it('rejects a cursor it did not issue', async () => {
        const { ctx } = setup(spec.happy);
        await expect(
          spec.provider.listItems(ctx, {
            libraryId: spec.expected.paged.libraryId,
            pageSize: 2,
            cursor: 'not-a-cursor',
          }),
        ).rejects.toMatchObject({ name: 'ProviderError', code: 'PROTOCOL' });
      });
    });

    describe('getItem', () => {
      it('returns a normalized item with external IDs and credits', async () => {
        const { item } = spec.expected;
        const { ctx, origin } = setup(spec.happy);
        const found = await spec.provider.getItem(ctx, item.id);
        expect(found).not.toBeNull();
        expect(found?.title).toBe(item.title);
        expect(found?.externalIds).toMatchObject(item.externalIds);
        expect(found?.credits.length).toBeGreaterThanOrEqual(item.minCredits);
        if (found) expectValidItem(found);
        expectNoStrayRequests(origin);
      });

      it('returns null for an item the origin does not have', async () => {
        const { unknownItem } = spec.expected;
        const { ctx } = setup([...spec.happy, ...unknownItem.routes]);
        expect(await spec.provider.getItem(ctx, unknownItem.id)).toBeNull();
      });
    });

    describe('errors and hygiene', () => {
      it('throws ProviderError, never a raw error, when the origin is unreachable', async () => {
        const { ctx } = setup(spec.happy, { unreachable: true });
        const err: unknown = await spec.provider.listLibraries(ctx).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProviderError);
        expect(err).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
      });

      it('refuses an off-host redirect on catalog calls too', async () => {
        const { ctx, origin } = setup(spec.happy, { redirectTo: 'https://evil.example/' });
        await expect(spec.provider.listLibraries(ctx)).rejects.toMatchObject({
          code: 'REDIRECT_REFUSED',
        });
        expect(origin.calls.every((c) => c.url.host === host)).toBe(true);
      });

      it('never puts the password in an error message', async () => {
        const { ctx } = setup(spec.failures.badCredentials);
        const err: unknown = await spec.provider.listLibraries(ctx).catch((e: unknown) => e);
        const secret = spec.secret.kind === 'password' ? spec.secret.password : spec.secret.token;
        expect((err as Error).message).not.toContain(secret);
      });
    });
  });
}
