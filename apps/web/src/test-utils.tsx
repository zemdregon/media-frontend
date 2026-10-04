import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type { ItemCard, ItemDetail, Me } from '@cinewren/shared';
import { App } from './App';

export type Reply = [number, unknown];
export type Handler = (method: string, path: string, body: unknown) => Reply | undefined;

/** Stubs `fetch`; `path` is the URL without `/api/v1`, including the query string. */
export function mockApi(handler: Handler) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const path = url.replace(/^\/api\/v1/, '');
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const [status, payload] = handler(init?.method ?? 'GET', path, body) ?? [
      404,
      { error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'r' } },
    ];
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export const viewer: Me = {
  id: 'u2',
  displayName: 'Vera Lynn',
  role: 'viewer',
  preferences: { theme: 'system' },
};
export const operator: Me = { ...viewer, id: 'u1', displayName: 'Olivia', role: 'operator' };

export const page = <T,>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });

export function card(over: Partial<ItemCard> & { id: string; title: string }): ItemCard {
  return {
    kind: 'movie',
    year: 1968,
    artworkUrl: null,
    copyCount: 1,
    serverCount: 1,
    bestCopy: { serverName: 'Basement NAS', serverStatus: 'active', label: '1080p' },
    ...over,
  };
}

export function detail(over: Partial<ItemDetail> & { id: string; title: string }): ItemDetail {
  return {
    ...card(over),
    overview: 'A group of strangers barricade themselves in a farmhouse.',
    genres: ['Horror'],
    versionsSummary: ['4K HDR', '1080p'],
    cast: [],
    collections: [],
    copies: [],
    ...over,
  };
}

/** Renders the whole app at `path` with `me` signed in; `handler` serves everything else. */
export function renderApp(path: string, me: Me, handler: Handler) {
  window.history.replaceState(null, '', path);
  const fetchMock = mockApi((m, p, b) => (p === '/me' ? [200, me] : handler(m, p, b)));
  render(<App />);
  return fetchMock;
}
