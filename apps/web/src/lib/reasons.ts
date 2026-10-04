/** Plain-language text for the reason codes in the LLD-API reasons table (FR-PLAY-010). */
import type { CopyRow, ReasonCode } from '../api-client/playback-types';

export const REASON_TEXT: Record<ReasonCode, string> = {
  direct_play: 'It plays as stored in this browser, so the server does no conversion.',
  direct_stream_container:
    'The file format is not supported here, so the server repackages it without re-encoding the video.',
  audio_transcoded: 'Only the audio is re-encoded, because this browser cannot play its codec.',
  transcode_video_codec:
    'The video format, profile or level is not supported here, so the server re-encodes the video. Expect a slower start.',
  subtitle_burn_in:
    'The subtitle you chose is image-based, so the server burns it into the picture.',
  hdr_unsupported:
    'This copy is HDR and this display cannot show it, so colors may be tone-mapped or another copy may suit better.',
  hdr_match: 'Its HDR format is supported by this display.',
  resolution_exceeds_device:
    'Its resolution is higher than this device or your quality limit allows.',
  highest_playable_resolution:
    'It has the best resolution this device can play without a transcode.',
  server_priority: 'It tied with other copies, and this server has the higher priority.',
  server_latency: 'It tied with other copies, and this server answered faster.',
  server_degraded:
    'This server is responding slowly or with errors, so it ranks below healthy ones.',
  server_unreachable:
    'This server is not answering right now, so the copy cannot be played. Cinewren offers it again when the server is back.',
  user_selected: 'You chose this copy.',
  failover: 'An earlier copy did not start, so this one was used instead.',
  origin_changed_mode:
    'The server decided on a different way of playing than first predicted, and Cinewren used what it returned.',
};

export function reasonSentence(code: string): string | null {
  return Object.hasOwn(REASON_TEXT, code) ? REASON_TEXT[code as ReasonCode] : null;
}

/** Sentences for known codes, in the given order. Unknown codes are ignored (LLD-API). */
export function reasonSentences(codes: readonly string[]): string[] {
  return codes.map(reasonSentence).filter((s): s is string => s !== null);
}

export function playabilityLabel(p: CopyRow['expectedPlayability']): {
  text: string;
  tone: 'ok' | 'warn' | 'bad' | 'muted';
} {
  switch (p) {
    case 'direct_play':
      return { text: 'Direct play', tone: 'ok' };
    case 'transcode':
      return { text: 'Needs transcode', tone: 'warn' };
    case 'unavailable':
      return { text: 'Unavailable', tone: 'bad' };
    default:
      return { text: 'Not checked', tone: 'muted' };
  }
}

const HDR_LABEL: Record<string, string> = {
  none: 'SDR',
  hdr10: 'HDR10',
  'hdr10+': 'HDR10+',
  hlg: 'HLG',
  dolby_vision: 'Dolby Vision',
  dv: 'Dolby Vision',
};

export const hdrLabel = (hdr: string): string => HDR_LABEL[hdr] ?? hdr.toUpperCase();

export function sizeLabel(bytes: number | null): string {
  if (bytes === null || bytes <= 0) return 'Unknown';
  const gb = bytes / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${String(Math.round(bytes / 1e6))} MB`;
}

export function audioLabel(a: CopyRow['audio']): string {
  const first = a[0];
  if (!first) return 'Unknown';
  const ch = first.channels;
  const layout = ch === null ? '' : ch === 6 ? ' 5.1' : ch === 8 ? ' 7.1' : ` ${String(ch)}.0`;
  return `${first.codec.toUpperCase()}${layout}`;
}

/** The callout headline, for example "Basement NAS: 1080p, direct play". */
export function copyHeadline(c: CopyRow): string {
  const res = c.resolution?.label ?? 'unknown resolution';
  const mode =
    c.expectedPlayability === 'direct_play'
      ? 'direct play'
      : c.expectedPlayability === 'transcode'
        ? 'needs a transcode'
        : c.expectedPlayability === 'unavailable'
          ? 'unavailable right now'
          : 'not checked on this device';
  return `${c.serverName}: ${res}, ${mode}`;
}

export function secondsLabel(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${String(h)}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}
