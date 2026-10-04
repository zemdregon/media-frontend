/**
 * Jellyfin adapter (IR-003, FR-SRV-002, FR-SRV-003, NFR-SEC-005; spike 2026-provider-spike.md).
 * Verified against Jellyfin 12.1.0 only. The catalog half is shared with Emby
 * (`mediabrowser.ts`); this file holds what is Jellyfin's own.
 *
 * Auth: the service account is a non-admin username and password. `AuthenticateByName` returns
 * an access token that is derived at runtime and sent as
 * `Authorization: MediaBrowser ..., Token="..."` (12.1 rejects `X-Emby-*` and `api_key=`).
 * The password is the only stored secret; the token is never persisted by Cinewren.
 */
import { createMediaBrowserCatalog } from './mediabrowser';
import {
  JELLYFIN_FLAVOR,
  mintSessionToken,
  negotiate,
  report,
  revokeSessionToken,
  streamDeviceId,
} from './mediabrowser-playback';
import type { MediaProvider } from './types';

/** IR-003: versions verified in the spike. */
export const JELLYFIN_MIN_VERSION = '12.1';

const catalog = createMediaBrowserCatalog({
  type: 'jellyfin',
  label: 'Jellyfin',
  minVersion: JELLYFIN_MIN_VERSION,
  productName: /jellyfin/i,
  viewsPath: (userId) => `/UserViews?userId=${encodeURIComponent(userId)}`,
  itemPath: (userId, id) =>
    `/Items/${encodeURIComponent(id)}?userId=${encodeURIComponent(userId)}&Fields=People,ProviderIds`,
  artworkWithToken: false,
});

export const jellyfinProvider: MediaProvider = {
  ...catalog,
  // Playback (M3, ADR-0013). Owner decision 2026-10-04: Jellyfin always streams through
  // token-gated HLS and never `static=true` direct play, which the origin does not authenticate.
  // Re-auth on one DeviceId kills its previous token, so every session gets its own DeviceId.
  streamDevices: 'per_session',
  createSessionCredential: (ctx, sessionId) => mintSessionToken(ctx, streamDeviceId(sessionId)),
  revokeSessionCredential: revokeSessionToken,
  negotiatePlayback: (ctx, req) => negotiate(ctx, JELLYFIN_FLAVOR, req),
  reportPlayback: report,
};
