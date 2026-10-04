/**
 * Emby playback (IR-004, ADR-0013 Emby amendment; spike 2026-provider-spike.md). Verified against
 * Emby 4.10.1.0 only. This is the playback half of the adapter; validation, libraries and sync
 * land with T4.1, so Emby servers cannot be registered yet.
 *
 * - Re-auth on the same DeviceId returns the same token, and logout leaves the device entry
 *   behind (the service account cannot delete devices). So stream credentials use a bounded,
 *   reusable DeviceId pool: the caller leases a slot per session and frees it after revocation.
 * - HLS segments of a live transcode survive revocation until the stop is reported, so the
 *   caller reports `stop` before revoking (LLD-TOKEN).
 * - The browser-URL token carrier is `api_key=` (`ApiKey=` returns 401 on Emby).
 */
import { ProviderError } from './errors';
import {
  EMBY_FLAVOR,
  mintSessionToken,
  negotiate,
  report,
  revokeSessionToken,
  streamDeviceId,
} from './mediabrowser-playback';
import type { PlaybackProvider } from './types';

export const embyPlayback: PlaybackProvider = {
  type: 'emby',
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
