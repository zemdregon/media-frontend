// T4.2: a provider whose stream-credential model is unverified (Plex until B-3) is browsable but
// never selected for playback, so no credential of an unverified model can reach a browser
// (ADR-0013). Selection excludes it with reason `provider_unverified`.
import { describe, expect, it } from 'vitest';
import { copyTable, selectCandidates, type Candidate } from '../../src/playback/select';
import { getPlaybackProvider } from '../../src/providers/registry';
import type { DeviceCapabilities } from '../../src/providers/types';

function cand(sourceId: string, over: Partial<Candidate> = {}): Candidate {
  return {
    sourceId,
    versionId: `${sourceId}-v`,
    providerItemId: `p-${sourceId}`,
    providerVersionId: `pv-${sourceId}`,
    serverId: `srv-${sourceId}`,
    serverName: `Server ${sourceId}`,
    serverType: 'emby',
    serverStatus: 'active',
    priority: 0,
    latencyMs: null,
    container: 'mp4',
    videoCodec: 'h264',
    width: 1920,
    height: 1080,
    hdr: 'none',
    sizeBytes: null,
    runtimeMs: 7_200_000,
    audio: [{ index: 1, codec: 'aac', channels: 2, language: 'en', title: null, default: true }],
    subtitles: [],
    ...over,
  };
}

const caps: DeviceCapabilities = {
  containers: ['mp4'],
  video: [{ codec: 'h264' }],
  audio: ['aac'],
  maxHeight: 1080,
  hdr: [],
  textSubtitles: ['vtt'],
  nativeHls: false,
  mse: true,
};

const plex = (id: string, over: Partial<Candidate> = {}) =>
  cand(id, { serverType: 'plex', playbackVerified: false, ...over });

describe('provider_unverified (ADR-0013, B-3)', () => {
  it('the Plex adapter is registered for playback and declares itself unverified', () => {
    expect(getPlaybackProvider('plex')?.playbackVerified).toBe(false);
    expect(getPlaybackProvider('jellyfin')?.playbackVerified).toBeUndefined();
  });

  it('a title that exists only on Plex is NO_PLAYABLE_SOURCE with provider_unverified', () => {
    expect(selectCandidates([plex('P')], caps, {})).toEqual({
      ok: false,
      error: 'no_playable',
      reason: 'provider_unverified',
    });
  });

  it('never ranks an unverified copy, even when it would be the best one', () => {
    const better = plex('P', { priority: 100, height: 2160, width: 3840 });
    const out = selectCandidates([better, cand('E')], caps, {});
    if (!out.ok) throw new Error('expected candidates');
    expect(out.ranked.map((r) => r.c.sourceId)).toEqual(['E']);
  });

  it('refuses a manual choice of an unverified copy instead of playing it', () => {
    expect(selectCandidates([plex('P'), cand('E')], caps, { sourceId: 'P' })).toEqual({
      ok: false,
      error: 'no_playable',
      reason: 'provider_unverified',
    });
  });

  it('keeps servers_unreachable when a verified server is down alongside an unverified one', () => {
    const out = selectCandidates([plex('P'), cand('E', { serverStatus: 'unreachable' })], caps, {});
    expect(out).toMatchObject({ ok: false, reason: 'servers_unreachable' });
  });

  it('shows the unverified copy in the copy table as unavailable, last, never selected', () => {
    const rows = copyTable([plex('P', { priority: 100 }), cand('E')], caps);
    expect(rows.map((r) => [r.c.sourceId, r.selected, r.expectedPlayability])).toEqual([
      ['E', true, 'direct_play'],
      ['P', false, 'unavailable'],
    ]);
    expect(rows[1]?.reasons).toEqual(['provider_unverified']);
  });
});
