/**
 * Catalog read contracts (LLD-API "Endpoints" and "Card shapes"; FR-CAT-002 to FR-CAT-006,
 * FR-CAT-008, FR-CAT-011, FR-CAT-012). Every shape here is already filtered by BR-1 on the server:
 * nothing in it can reveal a title, source, server or count the caller may not see.
 */
import { z } from 'zod';
import type { Page } from './auth';

export type CatalogType = 'movie' | 'series' | 'season' | 'episode';
export type ArtworkSlot = 'poster' | 'backdrop' | 'thumb';
export const ARTWORK_SLOTS = ['poster', 'backdrop', 'thumb'] as const;

/** A tile in a grid or row. `artworkUrl` is a same-origin proxy URL, never an origin URL. */
export interface ItemCard {
  id: string;
  type: CatalogType;
  title: string;
  year: number | null;
  artworkUrl: string | null;
}

export interface PersonCard {
  id: string;
  name: string;
  artworkUrl: string | null;
}

export interface CollectionCard {
  id: string;
  name: string;
  artworkUrl: string | null;
  /** Set only when another collection visible to the caller has the same name (ADR-0015). */
  serverLabel?: string;
}

/** `GET /api/v1/home`. `continueWatching` is filled from M3 (FR-CAT-008). */
export interface HomeResponse {
  recentlyAdded: ItemCard[];
  continueWatching: ItemCard[];
}

/** `GET /api/v1/search`; each group holds only hits visible under BR-1, with no totals. */
export interface SearchResponse {
  titles: Page<ItemCard>;
  people: Page<PersonCard>;
  collections: Page<CollectionCard>;
}

export type CreditRole = 'actor' | 'director' | 'writer' | 'producer' | 'other';

export interface ItemDetail {
  id: string;
  type: CatalogType;
  /** The parent season or series, only when the caller can see it. */
  parentId: string | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  overview: string | null;
  genres: string[];
  runtimeMs: number | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  artwork: Record<ArtworkSlot, string | null>;
  /** For example `["4K HDR", "1080p"]`, from the versions the caller can see (FR-CAT-005). */
  versionsSummary: string[];
  /** Servers the caller can play this title from (visible sources only). */
  serverCount: number;
  progress: { positionMs: number; watched: boolean } | null;
  /** Visible seasons of a series, or visible episodes of a season; null for movies and episodes. */
  children: { type: 'season' | 'episode'; count: number } | null;
  cast: { person: PersonCard; role: CreditRole; character: string | null }[];
  collections: { id: string; name: string }[];
}

/** `GET /api/v1/items/{id}/versions`. */
export interface VersionEntry {
  sourceId: string;
  versionId: string;
  label: string;
  height: number | null;
  hdr: string;
  videoCodec: string | null;
  serverName: string;
  serverStatus: string;
}

export interface PersonDetail {
  id: string;
  name: string;
  artworkUrl: string | null;
  credits: Page<{ item: ItemCard; role: CreditRole; character: string | null }>;
}

export interface CollectionDetail {
  id: string;
  name: string;
  overview: string | null;
  artworkUrl: string | null;
  members: Page<ItemCard>;
}

// --- query schemas (the Worker validates with the same definitions) ---

const limit = (max: number, fallback: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const cursor = z.string().min(1).max(2048);

export const browseQuery = z.object({
  type: z.enum(['movie', 'series']).optional(),
  sort: z.enum(['title', 'year', 'added']).default('title'),
  order: z.enum(['asc', 'desc']).optional(),
  genre: z.string().trim().min(1).max(64).optional(),
  yearFrom: z.coerce.number().int().min(1800).max(2200).optional(),
  yearTo: z.coerce.number().int().min(1800).max(2200).optional(),
  minHeight: z.coerce.number().int().min(1).max(10000).optional(),
  cursor: cursor.optional(),
  limit: limit(100, 50),
});

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  kind: z.enum(['title', 'person', 'collection']).optional(),
  cursor: cursor.optional(),
  limit: limit(50, 8),
});

export const pageQuery = z.object({ cursor: cursor.optional(), limit: limit(100, 50) });

export type BrowseQuery = z.output<typeof browseQuery>;
export type SearchQuery = z.output<typeof searchQuery>;
