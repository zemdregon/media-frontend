/**
 * Player route `/watch/:id` (T3.4, T3.5; FR-PLAY-001 to FR-PLAY-006, FR-PROG-001 to FR-PROG-004).
 * Full-viewport overlay. `Player` owns the play request (resume prompt, failover, track and copy
 * switches); `Surface` owns the `<video>`, hls.js, controls and session events. Origin media
 * always loads from the descriptor URL (FR-PLAY-008); hls.js is lazy-loaded here only.
 */
import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import { ApiError } from '../api-client';
import { getItem } from '../api-client/catalog';
import { getNextEpisode, play } from '../api-client/playback';
import type {
  CopyRow,
  PlaybackDescriptor,
  SubtitlePreference,
  SubtitleTrack,
  WithCopies,
} from '../api-client/playback-types';
import { CopiesPicker, copyKey } from '../components/CopiesPicker';
import { Alert, usePageTitle } from '../components/ui';
import { capsHeaders, getCapabilities } from '../lib/capabilities';
import { createReporter, type Reporter } from '../lib/playbackReporter';
import { secondsLabel } from '../lib/reasons';
import { Link, useRouter } from '../lib/router';
import { useLoad } from '../lib/useLoad';

/** No `playing` event within this long means the copy did not start (TDD §11.4, proposed). */
export const START_TIMEOUT_MS = 15_000;
const HIDE_CONTROLS_MS = 3_000;
const RESUME_PROMPT_MIN_MS = 60_000;
const NEXT_COUNTDOWN_S = 10;

interface Spec {
  sourceId: string | null;
  versionId: string | null;
  exclude: string[];
  replaces: string | null;
  audio: { language: string | null; index: number } | null;
  subtitle: SubtitlePreference;
  /** Position to start from; null means "use the stored resume position". */
  startAtMs: number | null;
}

type Phase =
  | { kind: 'requesting'; note: string | null }
  | { kind: 'ready'; d: PlaybackDescriptor; startAtMs: number; askResume: boolean }
  | {
      kind: 'error';
      title: string;
      message: string;
      /** Offer "Try another copy" (a replacement request that excludes this source). */
      failover: PlaybackDescriptor | null;
      positionMs: number;
    };

export function Player({ id }: { id: string }) {
  const { location, navigate } = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'requesting', note: null });
  const [initial] = useState<Spec>(() => ({
    sourceId: location.search.get('sourceId'),
    versionId: location.search.get('versionId'),
    exclude: [],
    replaces: null,
    audio: null,
    subtitle: { mode: 'off' },
    startAtMs: null,
  }));
  const skipPrompt = location.search.get('resume') === '1';
  const specRef = useRef<Spec | null>(null);
  const spec = {
    get current(): Spec {
      return specRef.current ?? initial;
    },
  };
  const reqId = useRef(0);

  /** Sends the play request; state changes only after the awaits, so effects may call it. */
  const request = useCallback(
    (next: Spec) => {
      specRef.current = next;
      const mine = ++reqId.current;
      void (async () => {
        try {
          const capabilities = await getCapabilities();
          const d = await play({
            itemId: id,
            capabilities,
            preferences: {
              audioLanguage: next.audio?.language ?? null,
              ...(next.audio ? { audioIndex: next.audio.index } : {}),
              subtitle: next.subtitle,
              maxHeight: null,
              sourceId: next.sourceId,
              versionId: next.versionId,
            },
            excludeSourceIds: next.exclude,
            replacesSessionId: next.replaces,
          });
          if (mine !== reqId.current) return;
          const stored = d.resume?.positionMs ?? 0;
          const ask = next.startAtMs === null && !skipPrompt && stored > RESUME_PROMPT_MIN_MS;
          setPhase({
            kind: 'ready',
            d,
            startAtMs: next.startAtMs ?? (ask ? 0 : stored),
            askResume: ask,
          });
        } catch (err) {
          if (mine !== reqId.current) return;
          setPhase(playError(err, next));
        }
      })();
    },
    [id, skipPrompt],
  );

  const start = (next: Spec, note: string | null = null) => {
    setPhase({ kind: 'requesting', note });
    request(next);
  };

  useEffect(() => {
    const counter = reqId;
    request(initial);
    return () => {
      counter.current++;
    };
  }, [request, initial]);

  const back = () => {
    navigate(`/items/${encodeURIComponent(id)}`);
  };

  /** Failover (FR-PLAY-004): a replacement request that excludes the source that failed. */
  const tryAnother = (failed: PlaybackDescriptor, positionMs: number) => {
    start(
      {
        ...spec.current,
        sourceId: null,
        versionId: null,
        exclude: [...spec.current.exclude, failed.source.id],
        replaces: failed.sessionId,
        startAtMs: positionMs,
      },
      'Trying another copy…',
    );
  };

  const retry = () => {
    start({ ...initial, exclude: [], replaces: null, startAtMs: null });
  };

  const title = phase.kind === 'ready' ? phase.d.item.title : 'Player';
  usePageTitle(phase.kind === 'ready' ? `Playing ${title}` : 'Player');

  if (phase.kind === 'requesting') {
    return (
      <PlayerFrame onBack={back} title={null}>
        <div className="player-panel" role="status" aria-live="polite">
          <span className="spinner" aria-hidden="true" />
          <p>{phase.note ?? 'Starting playback…'}</p>
        </div>
      </PlayerFrame>
    );
  }
  if (phase.kind === 'error') {
    const failed = phase.failover;
    return (
      <PlayerFrame onBack={back} title={null}>
        <div className="player-panel" role="alert">
          <h2 className="h-card">{phase.title}</h2>
          <p>{phase.message}</p>
          <div className="actions">
            {failed && failed.alternatives > 0 && (
              <button
                type="button"
                className="button button-primary"
                onClick={() => {
                  tryAnother(failed, phase.positionMs);
                }}
              >
                Try another copy
              </button>
            )}
            <button type="button" className="button button-outline" onClick={retry}>
              Retry
            </button>
            <Link to={`/items/${encodeURIComponent(id)}`} className="button button-outline">
              Back to title
            </Link>
          </div>
        </div>
      </PlayerFrame>
    );
  }
  if (phase.askResume) {
    const stored = phase.d.resume?.positionMs ?? 0;
    return (
      <PlayerFrame onBack={back} title={phase.d.item.title}>
        <ResumePrompt
          positionMs={stored}
          onResume={() => {
            setPhase({ ...phase, askResume: false, startAtMs: stored });
          }}
          onStartOver={() => {
            setPhase({ ...phase, askResume: false, startAtMs: 0 });
          }}
        />
      </PlayerFrame>
    );
  }
  const d = phase.d;
  return (
    <Surface
      key={d.sessionId}
      d={d}
      startAtMs={phase.startAtMs}
      onBack={back}
      onFatal={(code, positionMs) => {
        setPhase({
          kind: 'error',
          title: 'This copy did not start',
          message: `${d.source.serverName} could not play this copy (${code}). ${
            d.alternatives > 0
              ? 'You can try another copy.'
              : 'There is no other copy to try. Retry, or go back to the title.'
          }`,
          failover: d,
          positionMs,
        });
      }}
      onRequestTracks={(change, positionMs) => {
        start(
          {
            ...spec.current,
            sourceId: d.source.id,
            versionId: d.source.versionId,
            replaces: d.sessionId,
            startAtMs: positionMs,
            ...change,
          },
          'Switching tracks…',
        );
      }}
      onSwitchCopy={(copy, positionMs) => {
        start(
          {
            ...spec.current,
            sourceId: copy.sourceId,
            versionId: copy.versionId,
            exclude: [],
            replaces: d.sessionId,
            startAtMs: positionMs,
          },
          `Switching to ${copy.serverName}…`,
        );
      }}
      onExpired={(positionMs) => {
        start(
          {
            ...spec.current,
            sourceId: d.source.id,
            versionId: d.source.versionId,
            replaces: d.sessionId,
            startAtMs: positionMs,
          },
          'Your playback session expired. Reconnecting…',
        );
      }}
    />
  );
}

function playError(err: unknown, spec: Spec): Phase {
  const none = err instanceof ApiError && err.code === 'NO_PLAYABLE_SOURCE';
  return {
    kind: 'error',
    title: none ? 'No copy can play right now' : "Can't start playback",
    message: none
      ? spec.exclude.length > 0
        ? 'Every other copy has failed or is offline. Retry in a moment, or go back to the title.'
        : 'Every copy is offline or cannot play on this device. Go back to the title to see why.'
      : err instanceof ApiError
        ? err.message
        : 'Something went wrong. Try again.',
    failover: null,
    positionMs: spec.startAtMs ?? 0,
  };
}

function PlayerFrame({
  children,
  onBack,
  title,
}: {
  children: React.ReactNode;
  onBack: () => void;
  title: string | null;
}) {
  return (
    <div className="player" role="region" aria-label="Video player">
      <div className="player-top" style={{ opacity: 1 }}>
        <button type="button" className="player-button" onClick={onBack}>
          <span aria-hidden="true">←</span> Back
        </button>
        <h1 className="player-title">{title ?? 'Player'}</h1>
      </div>
      {children}
    </div>
  );
}

function ResumePrompt({
  positionMs,
  onResume,
  onStartOver,
}: {
  positionMs: number;
  onResume: () => void;
  onStartOver: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const h = useId();
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <section className="player-panel" role="dialog" aria-modal="true" aria-labelledby={h}>
      <h2 id={h} className="h-card">
        Pick up where you left off?
      </h2>
      <div className="actions">
        <button ref={ref} type="button" className="button button-primary" onClick={onResume}>
          Resume from {secondsLabel(positionMs / 1000)}
        </button>
        <button type="button" className="button button-outline" onClick={onStartOver}>
          Start over
        </button>
      </div>
    </section>
  );
}

type Menu = null | 'tracks' | 'copy';

function Surface({
  d,
  startAtMs,
  onBack,
  onFatal,
  onRequestTracks,
  onSwitchCopy,
  onExpired,
}: {
  d: PlaybackDescriptor;
  startAtMs: number;
  onBack: () => void;
  onFatal: (code: string, positionMs: number) => void;
  onRequestTracks: (change: Partial<Pick<Spec, 'audio' | 'subtitle'>>, positionMs: number) => void;
  onSwitchCopy: (copy: CopyRow, positionMs: number) => void;
  onExpired: (positionMs: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackEls = useRef<Record<number, HTMLTrackElement | null>>({});
  const reporter = useRef<Reporter | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fatalSent = useRef(false);

  const [playing, setPlaying] = useState(false);
  const [buffering, setBuffering] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(d.item.runtimeMs ? d.item.runtimeMs / 1000 : 0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [visible, setVisible] = useState(true);
  const [menu, setMenu] = useState<Menu>(null);
  const [ended, setEnded] = useState(false);
  const textTracks = d.subtitleTracks.filter((t) => t.kind === 'text' && t.url);
  const burnedIn = d.subtitleTracks.some((t) => t.selected && t.kind === 'image');
  const [subSel, setSubSel] = useState<number | null>(
    () => d.subtitleTracks.find((t) => t.selected && t.kind === 'text')?.index ?? null,
  );
  const lastSub = useRef<number | null>(subSel ?? textTracks[0]?.index ?? null);
  const [announce, setAnnounce] = useState('');

  const posMs = () => (videoRef.current ? videoRef.current.currentTime * 1000 : 0);

  const poke = useCallback(() => {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      const box = boxRef.current;
      const inControls =
        box?.contains(document.activeElement) &&
        box.querySelector('.player-bottom')?.contains(document.activeElement);
      if (!inControls) setVisible(false);
    }, HIDE_CONTROLS_MS);
  }, []);

  const fatal = useCallback(
    (code: string) => {
      if (fatalSent.current) return;
      fatalSent.current = true;
      const pos = posMs();
      reporter.current?.send('error', code);
      reporter.current?.close();
      onFatal(code, pos);
    },
    [onFatal],
  );

  // Attach the stream: progressive for direct play, native HLS where the browser has it, else hls.js.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let cancelled = false;
    let hls: { destroy: () => void } | null = null;
    const watchdog = setTimeout(() => {
      fatal('start_timeout');
    }, START_TIMEOUT_MS);
    const onMeta = () => {
      if (startAtMs > 0) v.currentTime = startAtMs / 1000;
    };
    v.addEventListener('loadedmetadata', onMeta, { once: true });
    const onPlaying = () => {
      clearTimeout(watchdog);
    };
    v.addEventListener('playing', onPlaying, { once: true });

    const begin = () => {
      const p = v.play() as Promise<void> | undefined;
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // Autoplay blocked: the player stays paused and the Play button starts it.
          setBuffering(false);
        });
      }
    };

    if (d.streamType === 'progressive' || v.canPlayType('application/vnd.apple.mpegurl') !== '') {
      v.src = d.streamUrl;
      begin();
    } else {
      void import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          fatal('hls_unsupported');
          return;
        }
        const h = new Hls();
        hls = h;
        let recovered = false;
        h.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
            recovered = true;
            h.recoverMediaError();
            return;
          }
          fatal(`hls_${data.type}`);
        });
        h.loadSource(d.streamUrl);
        h.attachMedia(v);
        begin();
      });
    }
    return () => {
      cancelled = true;
      clearTimeout(watchdog);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('playing', onPlaying);
      hls?.destroy();
      v.removeAttribute('src');
    };
    // The stream is attached once per descriptor; the surface is keyed by session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session events and progress (FR-PROG-001, FR-PLAY-009).
  useEffect(() => {
    const r = createReporter({
      sessionId: d.sessionId,
      getPositionMs: posMs,
      onExpired: () => {
        onExpired(posMs());
      },
    });
    reporter.current = r;
    const onHide = () => {
      if (document.visibilityState === 'hidden') r.hide();
    };
    const onPageHide = () => {
      r.hide();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      r.send('stop');
      r.close();
      reporter.current = null;
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show the chosen text track and hide the rest.
  useEffect(() => {
    for (const t of textTracks) {
      const track = trackEls.current[t.index]?.track;
      if (track) track.mode = t.index === subSel ? 'showing' : 'disabled';
    }
  }, [subSel, textTracks]);

  const started = useRef(false);
  const videoHandlers = {
    onPlaying: () => {
      setPlaying(true);
      setBuffering(false);
      if (!started.current) {
        started.current = true;
        reporter.current?.send('start');
      }
      reporter.current?.startTicker();
      poke();
    },
    onPause: () => {
      setPlaying(false);
      setVisible(true);
      const v = videoRef.current;
      if (v?.ended) return;
      reporter.current?.stopTicker();
      if (started.current) reporter.current?.send('pause');
    },
    onSeeked: () => {
      if (started.current) reporter.current?.send('progress');
    },
    onWaiting: () => {
      setBuffering(true);
    },
    onCanPlay: () => {
      setBuffering(false);
    },
    onTimeUpdate: () => {
      setTime(videoRef.current?.currentTime ?? 0);
    },
    onDurationChange: () => {
      const dur = videoRef.current?.duration;
      if (dur && Number.isFinite(dur)) setDuration(dur);
    },
    onVolumeChange: () => {
      const v = videoRef.current;
      if (v) {
        setVolume(v.volume);
        setMuted(v.muted);
      }
    },
    onEnded: () => {
      reporter.current?.stopTicker();
      reporter.current?.send('stop');
      reporter.current?.close();
      setPlaying(false);
      setEnded(true);
      setVisible(true);
    },
    onError: () => {
      const v = videoRef.current;
      if (!v?.getAttribute('src')) return;
      fatal(`media_error_${String(v.error?.code ?? 0)}`);
    },
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };
  const seekBy = (sec: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + sec));
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (v) v.muted = !v.muted;
  };
  const toggleFullscreen = () => {
    const box = boxRef.current;
    if (!box) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void box.requestFullscreen();
  };
  const chooseSubtitle = (t: SubtitleTrack | null) => {
    if (!t) {
      if (burnedIn) onRequestTracks({ subtitle: { mode: 'off' } }, posMs());
      else setSubSel(null);
      setAnnounce('Captions off');
      return;
    }
    if (t.kind === 'image' || burnedIn) {
      onRequestTracks({ subtitle: { mode: 'track', index: t.index, kind: t.kind } }, posMs());
      return;
    }
    lastSub.current = t.index;
    setSubSel(t.index);
    setAnnounce(`Captions on, ${t.label}`);
  };
  const toggleCaptions = () => {
    if (subSel !== null) chooseSubtitle(null);
    else {
      const t = d.subtitleTracks.find((x) => x.index === lastSub.current) ?? textTracks[0];
      if (t) chooseSubtitle(t);
    }
  };
  const chooseAudio = (index: number) => {
    const t = d.audioTracks.find((a) => a.index === index);
    if (!t || t.selected) return;
    onRequestTracks({ audio: { language: t.language, index: t.index } }, posMs());
  };

  const handleKey = (e: KeyboardEvent) => {
    poke();
    const target = e.target as HTMLElement;
    const onRange = target instanceof HTMLInputElement && target.type === 'range';
    const onControl =
      target instanceof HTMLButtonElement ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLAnchorElement;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Typing in a text field (such as the page search under the overlay) is not a shortcut.
    if (target instanceof HTMLInputElement && !['range', 'radio'].includes(target.type)) return;
    switch (e.key) {
      case 'Escape':
        if (menu) {
          e.preventDefault();
          setMenu(null);
        }
        return;
      case ' ':
        if (onControl) return; // native activation
        e.preventDefault();
        togglePlay();
        return;
      case 'k':
      case 'K':
        e.preventDefault();
        togglePlay();
        return;
      case 'ArrowLeft':
        if (onRange || target.getAttribute('role') === 'radio') return;
        e.preventDefault();
        seekBy(-10);
        return;
      case 'ArrowRight':
        if (onRange || target.getAttribute('role') === 'radio') return;
        e.preventDefault();
        seekBy(10);
        return;
      case 'ArrowUp':
      case 'ArrowDown':
        if (onRange || target.getAttribute('role') === 'radio' || menu) return;
        e.preventDefault();
        if (videoRef.current) {
          videoRef.current.volume = Math.max(
            0,
            Math.min(1, videoRef.current.volume + (e.key === 'ArrowUp' ? 0.1 : -0.1)),
          );
        }
        return;
      case 'f':
      case 'F':
        e.preventDefault();
        toggleFullscreen();
        return;
      case 'm':
      case 'M':
        e.preventDefault();
        toggleMute();
        return;
      case 'c':
      case 'C':
        e.preventDefault();
        toggleCaptions();
        return;
    }
  };

  // Shortcuts work wherever focus is, since the overlay covers the page.
  const onKey = useEffectEvent(handleKey);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      onKey(e);
    };
    document.addEventListener('keydown', listener);
    boxRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', listener);
    };
  }, []);

  const selectedAudio = d.audioTracks.find((a) => a.selected)?.index;
  const showControls = visible || !playing || menu !== null;

  return (
    <div
      ref={boxRef}
      className={`player${showControls ? '' : ' player-idle'}`}
      role="region"
      aria-label="Video player"
      tabIndex={-1}
      onPointerMove={poke}
    >
      <video
        ref={videoRef}
        className="player-video"
        crossOrigin="anonymous"
        playsInline
        onClick={togglePlay}
        {...videoHandlers}
      >
        {textTracks.map((t) => (
          <track
            key={t.index}
            ref={(el) => {
              trackEls.current[t.index] = el;
            }}
            kind="subtitles"
            src={t.url}
            label={t.label}
            {...(t.language ? { srcLang: t.language } : {})}
          />
        ))}
      </video>

      <div className="player-top">
        <button type="button" className="player-button" onClick={onBack}>
          <span aria-hidden="true">←</span> Back
        </button>
        <h1 className="player-title">{d.item.title}</h1>
        <span
          className="player-chip"
          aria-label={`Playing from ${d.source.serverName}, ${d.mode.replace(/_/g, ' ')}`}
        >
          {d.source.serverName} · {d.source.label}
        </span>
      </div>

      {buffering && !ended && (
        <div className="player-center" role="status">
          <span className="spinner" aria-hidden="true" />
          Buffering
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>

      {ended && <UpNext itemId={d.item.id} onBack={onBack} />}

      <div className="player-bottom">
        <div className="player-seek">
          <span className="mono-value">{secondsLabel(time)}</span>
          <input
            type="range"
            aria-label="Seek"
            aria-valuetext={`${secondsLabel(time)} of ${secondsLabel(duration)}`}
            min={0}
            max={Math.max(1, Math.floor(duration))}
            step={5}
            value={Math.min(Math.floor(time), Math.max(1, Math.floor(duration)))}
            onChange={(e) => {
              const v = videoRef.current;
              if (v) v.currentTime = Number(e.target.value);
            }}
          />
          <span className="mono-value">{secondsLabel(duration)}</span>
        </div>
        <div className="player-controls">
          <button type="button" className="player-button" onClick={togglePlay}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button
            type="button"
            className="player-button"
            onClick={() => {
              seekBy(-10);
            }}
          >
            Back 10 s
          </button>
          <button
            type="button"
            className="player-button"
            onClick={() => {
              seekBy(10);
            }}
          >
            Forward 10 s
          </button>
          <button type="button" className="player-button" aria-pressed={muted} onClick={toggleMute}>
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const v = videoRef.current;
              if (v) {
                v.volume = Number(e.target.value);
                v.muted = false;
              }
            }}
          />
          <span className="player-spacer" />
          <button
            type="button"
            className="player-button"
            aria-pressed={subSel !== null || burnedIn}
            disabled={d.subtitleTracks.length === 0}
            onClick={toggleCaptions}
          >
            Captions
          </button>
          <button
            type="button"
            className="player-button"
            aria-haspopup="true"
            aria-expanded={menu === 'tracks'}
            onClick={() => {
              setMenu(menu === 'tracks' ? null : 'tracks');
            }}
          >
            Audio and subtitles
          </button>
          <button
            type="button"
            className="player-button"
            aria-haspopup="true"
            aria-expanded={menu === 'copy'}
            onClick={() => {
              setMenu(menu === 'copy' ? null : 'copy');
            }}
          >
            Copy
          </button>
          <button type="button" className="player-button" onClick={toggleFullscreen}>
            Fullscreen
          </button>
        </div>
      </div>

      {menu === 'tracks' && (
        <div className="player-menu" role="group" aria-label="Audio and subtitles">
          <fieldset>
            <legend className="mono-label">Audio</legend>
            {d.audioTracks.length === 0 && <p className="helper">One audio track.</p>}
            {d.audioTracks.map((a) => (
              <label key={a.index} className="menu-option">
                <input
                  type="radio"
                  name="audio-track"
                  checked={a.index === selectedAudio}
                  onChange={() => {
                    chooseAudio(a.index);
                  }}
                />
                {a.label}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend className="mono-label">Subtitles</legend>
            <label className="menu-option">
              <input
                type="radio"
                name="subtitle-track"
                checked={subSel === null && !burnedIn}
                onChange={() => {
                  chooseSubtitle(null);
                }}
              />
              Off
            </label>
            {d.subtitleTracks.map((t) => (
              <label key={t.index} className="menu-option">
                <input
                  type="radio"
                  name="subtitle-track"
                  checked={t.kind === 'image' ? t.selected : subSel === t.index && !burnedIn}
                  onChange={() => {
                    chooseSubtitle(t);
                  }}
                />
                {t.label}
                {t.kind === 'image' ? ' (burned in)' : ''}
              </label>
            ))}
          </fieldset>
        </div>
      )}
      {menu === 'copy' && (
        <CopyMenu
          d={d}
          onPick={(c) => {
            setMenu(null);
            onSwitchCopy(c, posMs());
          }}
          onClose={() => {
            setMenu(null);
          }}
        />
      )}
    </div>
  );
}

/** Manual version choice while playing (FR-PLAY-005): the copies radiogroup, then a switch. */
function CopyMenu({
  d,
  onPick,
  onClose,
}: {
  d: PlaybackDescriptor;
  onPick: (c: CopyRow) => void;
  onClose: () => void;
}) {
  const { state, reload } = useLoad(
    async () => getItem(d.item.id, await capsHeaders()),
    `player-copies:${d.item.id}`,
  );
  const [picked, setPicked] = useState<string | null>(`${d.source.id}:${d.source.versionId}`);
  const h = useId();
  const copies = state.status === 'ready' ? ((state.data as WithCopies).copies ?? []) : [];
  const chosen = copies.find((c) => copyKey(c) === picked);
  const playingNow = picked === `${d.source.id}:${d.source.versionId}`;
  return (
    <div className="player-menu player-menu-wide" role="group" aria-labelledby={h}>
      <h2 id={h} className="h-card">
        Choose a copy
      </h2>
      {state.status === 'loading' && <p className="helper">Loading copies…</p>}
      {state.status === 'error' && <Alert message={state.message} onRetry={reload} />}
      {state.status === 'ready' && copies.length === 0 && (
        <p className="helper">No other copy is listed.</p>
      )}
      {copies.length > 0 && (
        <CopiesPicker copies={copies} value={picked} onChange={setPicked} labelledBy={h} />
      )}
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!chosen || playingNow || chosen.expectedPlayability === 'unavailable'}
          onClick={() => {
            if (chosen) onPick(chosen);
          }}
        >
          {playingNow ? 'Playing this copy' : 'Play this copy'}
        </button>
        <button type="button" className="button button-outline" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** End of playback: the next-episode card with a 10 s countdown (FR-PROG-004), or back to the title. */
function UpNext({ itemId, onBack }: { itemId: string; onBack: () => void }) {
  const { navigate } = useRouter();
  const { state } = useLoad(() => getNextEpisode(itemId), `up-next:${itemId}`);
  const next = state.status === 'ready' ? state.data : null;
  const [left, setLeft] = useState(NEXT_COUNTDOWN_S);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    if (!next || cancelled) return;
    const t = setInterval(() => {
      setLeft((n) => n - 1);
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [next, cancelled]);

  useEffect(() => {
    if (next && !cancelled && left <= 0) navigate(`/watch/${encodeURIComponent(next.id)}`);
  }, [left, next, cancelled, navigate]);

  if (state.status === 'loading') return null;
  if (!next) {
    return (
      <div className="player-panel" role="status">
        <h2 className="h-card">That is the end</h2>
        <button type="button" className="button button-primary" onClick={onBack}>
          Back to title
        </button>
      </div>
    );
  }
  return (
    <div className="player-panel" role="status" aria-live="polite">
      <p className="mono-label">Up next</p>
      <h2 className="h-card">{next.title}</h2>
      {!cancelled && <p>Starts in {String(Math.max(0, left))} s</p>}
      <div className="actions">
        <Link to={`/watch/${encodeURIComponent(next.id)}`} className="button button-primary">
          Play next episode
        </Link>
        {!cancelled && (
          <button
            type="button"
            className="button button-outline"
            onClick={() => {
              setCancelled(true);
            }}
          >
            Cancel
          </button>
        )}
        <button type="button" className="button button-outline" onClick={onBack}>
          Back to title
        </button>
      </div>
    </div>
  );
}
