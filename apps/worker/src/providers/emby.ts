/**
 * Emby adapter (IR-004, FR-SRV-002, ADR-0013 Emby amendment; spike 2026-provider-spike.md).
 * Verified against Emby 4.10.1.0 only. The catalog half is shared with Jellyfin
 * (`mediabrowser.ts`); Emby differs in `/Users/{id}/Views` and `/Users/{id}/Items/{id}`, in
 * sending no `ProductName` on `/System/Info/Public`, and in the playback rules below.
 *
 * - Re-auth on the same DeviceId returns the same token, and logout leaves the device entry
 *   behind (the service account cannot delete devices). So stream credentials use a bounded,
 *   reusable DeviceId pool: the caller leases a slot per session and frees it after revocation.
 * - HLS segments of a live transcode survive revocation until the stop is reported, so the
 *   caller reports `stop` before revoking (LLD-TOKEN).
 * - The browser-URL token carrier is `api_key=` (`ApiKey=` returns 401 on Emby).
 */
import { ProviderError } from './errors';
import { createMediaBrowserCatalog } from './mediabrowser';
import {
  EMBY_FLAVOR,
  mintSessionToken,
  negotiate,
  report,
  revokeSessionToken,
  streamDeviceId,
} from './mediabrowser-playback';
import type { MediaProvider } from './types';

/** IR-004: 4.10.1.0 was verified in the spike. */
export const EMBY_MIN_VERSION = '4.10';

const catalog = createMediaBrowserCatalog({
  type: 'emby',
  label: 'Emby',
  minVersion: EMBY_MIN_VERSION,
  productName: /emby/i,
  viewsPath: (userId) => `/Users/${encodeURIComponent(userId)}/Views`,
  itemPath: (userId, id) =>
    `/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(id)}?Fields=People,ProviderIds`,
  artworkWithToken: true,
});

export const embyProvider: MediaProvider = {
  ...catalog,
  streamDevices: 'pooled',
  createSessionCredential: (ctx, sessionId, lease) => {
    if (!lease) {
      return Promise.reject(
        new ProviderError('PROTOCOL', 'Emby stream credentials need a DeviceId pool slot.', false),
      );
    }
    return mintSessionToken(ctx, streamDeviceId(sessionId, lease));
  },
  revokeSessionCredential: revokeSessionToken,
  negotiatePlayback: (ctx, req) => negotiate(ctx, EMBY_FLAVOR, req),
  reportPlayback: report,
};
