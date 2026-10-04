import type { HealthProbe, Server, ServerHealth as Health } from '@cinewren/shared';
import { getServerHealth } from '../api-client/ops';
import { Alert, SkeletonBlock, StatusDot } from '../components/ui';
import { useLoad } from '../lib/useLoad';

/**
 * Health section of a server card (UX §8 "Operator: health", FR-OPS-004): current status, the
 * Worker-measured latency, and a strip of the most recent probes. Every cell carries a text
 * alternative, so status is never conveyed by colour alone.
 */

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted'> = {
  active: 'ok',
  degraded: 'warn',
  unreachable: 'bad',
};

const LABEL: Record<string, string> = {
  active: 'Healthy',
  degraded: 'Degraded',
  unreachable: 'Unreachable',
};

function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function describeProbe(p: HealthProbe): string {
  return p.ok
    ? `${when(p.at)}: reachable${p.latencyMs === null ? '' : `, ${String(p.latencyMs)} ms`}`
    : `${when(p.at)}: failed${p.errorCode ? ` (${p.errorCode})` : ''}`;
}

/** Since when the server has been failing: the unbroken run of failed probes up to now. */
function failingSince(health: Health): string | null {
  const [newest] = health.probes;
  if (!newest || newest.ok) return null;
  let at = newest.at;
  for (const p of health.probes) {
    if (p.ok) break;
    at = p.at;
  }
  return `Failing since ${when(at)}`;
}

export function ServerHealthPanel({ server }: { server: Server }) {
  const { state, reload } = useLoad(() => getServerHealth(server.id), `health:${server.id}`);
  if (['disabled', 'removing', 'pending_validation'].includes(server.status)) return null;
  return (
    <section className="health-panel" aria-label={`Health of ${server.name}`}>
      <h3 className="mono-label">Health</h3>
      {state.status === 'loading' && <SkeletonBlock label={`Loading health of ${server.name}`} />}
      {state.status === 'error' && <Alert message={state.message} onRetry={reload} />}
      {state.status === 'ready' && <Ready health={state.data} />}
    </section>
  );
}

function Ready({ health }: { health: Health }) {
  const since = failingSince(health);
  // Oldest on the left, like a timeline.
  const cells = [...health.probes].reverse();
  return (
    <>
      <p>
        <StatusDot
          tone={TONE[health.status] ?? 'muted'}
          label={LABEL[health.status] ?? health.status}
        />
        {health.lastLatencyMs !== null && (
          <span className="helper"> {health.lastLatencyMs} ms from Cinewren</span>
        )}
      </p>
      {since && <p className="helper">{since}</p>}
      {cells.length === 0 ? (
        <p className="helper">No probes yet. The first one runs within a few minutes.</p>
      ) : (
        <ol className="probe-strip" aria-label="Recent probes, oldest first">
          {cells.map((p) => (
            <li
              key={p.at}
              className={`probe-cell ${p.ok ? 'probe-ok' : 'probe-fail'}`}
              title={describeProbe(p)}
            >
              <span className="sr-only">{describeProbe(p)}</span>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
