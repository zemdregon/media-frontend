/**
 * `sources.content_hash` (LLD-SCHEMA): a hash of the normalized fields, including versions and
 * credits, so a re-run over unchanged origin data is skipped (FR-SYNC-004). `providerUpdatedAt`
 * is excluded on purpose: Jellyfin re-saves items on every scan (spike 3c), and a bumped
 * timestamp alone must not rewrite anything.
 */
import type { NormalizedItem } from '../providers/types';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export async function contentHash(item: NormalizedItem, libraryId: string): Promise<string> {
  const { providerUpdatedAt: _ignored, ...rest } = item;
  const bytes = new TextEncoder().encode(stable({ ...rest, libraryId }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
