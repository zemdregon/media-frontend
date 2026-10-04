import { render } from '@testing-library/react';
import { vi } from 'vitest';
import type {
  ItemCard,
  ItemCopy,
  ItemDetailWithCopies,
  Me,
  PlaybackDescriptor,
} from '@cinewren/shared';
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
    type: 'movie',
    year: 1968,
    seasonNumber: null,
    episodeNumber: null,
    artworkUrl: null,
    ...over,
  };
}

export function detail(
  over: Partial<ItemDetailWithCopies> & { id: string; title: string },
): ItemDetailWithCopies {
  return {
    type: 'movie',
    parentId: null,
    originalTitle: null,
    year: 1968,
    overview: 'A group of strangers barricade themselves in a farmhouse.',
    genres: ['Horror'],
    runtimeMs: null,
    seasonNumber: null,
    episodeNumber: null,
    artwork: { poster: null, backdrop: null, thumb: null },
    versionsSummary: ['4K HDR', '1080p'],
    serverCount: 1,
    progress: null,
    children: null,
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

export function copyRow(over: Partial<ItemCopy> & { sourceId: string }): ItemCopy {
  return {
    versionId: `v-${over.sourceId}`,
    serverName: 'Basement NAS',
    serverType: 'jellyfin',
    serverStatus: 'active',
    resolution: { width: 1920, height: 1080, label: '1080p' },
    hdr: 'none',
    videoCodec: 'h264',
    container: 'mp4',
    audio: [{ codec: 'flac', channels: 2, language: 'en' }],
    sizeBytes: 14_200_000_000,
    expectedPlayability: 'direct_play',
    reasons: ['direct_play'],
    selected: false,
    ...over,
  };
}

export function descriptor(over: Partial<PlaybackDescriptor> = {}): PlaybackDescriptor {
  return {
    sessionId: 'ps1',
    expiresAt: 4_000_000_000_000,
    item: { id: 'm1', title: 'Metropolis', runtimeMs: 7_200_000 },
    source: { id: 's1', versionId: 'v1', serverName: 'Basement NAS', label: '1080p · H.264' },
    mode: 'direct_play',
    streamUrl: 'https://media-a.example.net/stream/m1.mp4?token=t1',
    streamType: 'progressive',
    audioTracks: [
      {
        index: 1,
        label: 'English 5.1 (AAC)',
        language: 'en',
        codec: 'aac',
        channels: 6,
        selected: true,
      },
    ],
    subtitleTracks: [],
    resume: null,
    reasons: ['direct_play'],
    alternatives: 1,
    ...over,
  };
}
