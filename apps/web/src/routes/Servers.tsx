import { useCallback, useEffect, useState, type MouseEvent, type SyntheticEvent } from 'react';
import type { Library, Server, ServerDetail } from '@cinewren/shared';
import { api, ApiError } from '../api-client';
import { Alert } from './AuthCard';
import { useRouter } from '../lib/router';

/** Operator "Servers" page: the server list and the add-server form (UX §8a, FR-SRV-001..003). */

const STATUS_TEXT: Record<Server['status'], string> = {
  pending_validation: 'Not active yet',
  active: 'Online',
  degraded: 'Degraded',
  unreachable: 'Offline',
  disabled: 'Disabled',
  removing: 'Removing',
};

function messageFor(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Try again.';
}

export function Servers() {
  const { navigate } = useRouter();
  const goSync = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    navigate('/servers/sync');
  };
  const [servers, setServers] = useState<Server[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(() => {
    api<Server[]>('GET', '/admin/servers').then(
      (list) => {
        setServers(list);
        setError(null);
      },
      (err: unknown) => {
        setError(messageFor(err));
      },
    );
  }, []);

  useEffect(load, [load]);

  return (
    <div className="servers-page">
      <div className="page-head">
        <h1>Servers</h1>
        <div className="actions">
          <a className="button button-outline" href="/servers/sync" onClick={goSync}>
            Sync status
          </a>
          {!adding && (
            <button
              className="button button-primary-inline"
              type="button"
              onClick={() => {
                setAdding(true);
              }}
            >
              Add server
            </button>
          )}
        </div>
      </div>
      <Alert message={error} />
      {adding && (
        <AddServer
          onCancel={() => {
            setAdding(false);
          }}
          onAdded={() => {
            setAdding(false);
            load();
          }}
        />
      )}
      {servers === null && !error && <p className="helper">Loading…</p>}
      {servers?.length === 0 && !adding && (
        <section className="card-wide">
          <h2>No servers yet</h2>
          <p className="helper">Add a Jellyfin server to start building your catalog.</p>
        </section>
      )}
      <div className="server-list">
        {servers?.map((s) => (
          <ServerCard key={s.id} server={s} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

function AddServer({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<ServerDetail | null>(null);

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const server = await api<ServerDetail>('POST', '/admin/servers', {
        type: 'jellyfin',
        name,
        baseUrl,
        credentials: { username, password },
      });
      setPassword('');
      setAdded(server);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  if (added) {
    return (
      <section className="panel" aria-labelledby="added-title">
        <h2 id="added-title">{added.name} is connected</h2>
        <p className="helper">
          Choose the libraries to include. Libraries you leave off are not indexed.
        </p>
        <Libraries serverId={added.id} initial={added.libraries} />
        <button className="button" type="button" onClick={onAdded}>
          Done
        </button>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="add-title">
      <h2 id="add-title">Add a server</h2>
      <div className="segmented" role="group" aria-label="Server type">
        <button type="button" aria-pressed="true" className="segment segment-on">
          Jellyfin
        </button>
        <button type="button" className="segment" disabled title="Coming in a later release">
          Emby
        </button>
        <button type="button" className="segment" disabled title="Coming in a later release">
          Plex
        </button>
      </div>
      <Alert message={error} />
      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor="srv-name">Display name</label>
          <input
            id="srv-name"
            required
            maxLength={64}
            value={name}
            placeholder="Basement NAS"
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="srv-url">Server address</label>
          <input
            id="srv-url"
            required
            type="url"
            inputMode="url"
            autoComplete="off"
            value={baseUrl}
            placeholder="https://media.example.com"
            onChange={(e) => {
              setBaseUrl(e.target.value);
            }}
          />
          <span className="helper">
            Must start with https:// and be reachable from the internet.
          </span>
        </div>
        <div className="field">
          <label htmlFor="srv-user">Service account username</label>
          <input
            id="srv-user"
            required
            autoComplete="off"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="srv-pass">Password</label>
          <input
            id="srv-pass"
            required
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
          <span className="helper">
            Create a dedicated, non-admin account on your server for Cinewren. Administrator
            accounts are refused.
          </span>
        </div>
        <div className="form-actions">
          <button className="button button-primary-inline" type="submit" disabled={busy}>
            {busy ? 'Checking the server…' : 'Add server'}
          </button>
          <button className="button" type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function Libraries({ serverId, initial }: { serverId: string; initial: Library[] }) {
  const [libraries, setLibraries] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (library: Library, enabled: boolean) => {
    setError(null);
    try {
      const updated = await api<Library>('PATCH', `/admin/libraries/${library.id}`, { enabled });
      setLibraries((all) => all.map((l) => (l.id === updated.id ? updated : l)));
    } catch (err) {
      setError(messageFor(err));
    }
  };

  if (libraries.length === 0) {
    return <p className="helper">This server has no movie or TV libraries.</p>;
  }
  return (
    <fieldset className="libraries" data-server={serverId}>
      <legend className="helper">Libraries</legend>
      <Alert message={error} />
      {libraries.map((l) => (
        <label key={l.id} className="check">
          <input
            type="checkbox"
            checked={l.enabled}
            onChange={(e) => void toggle(l, e.target.checked)}
          />
          {l.name} <span className="helper">{l.kind === 'tv' ? 'TV' : 'Movies'}</span>
        </label>
      ))}
      {!libraries.some((l) => l.enabled) && (
        <p className="helper">No libraries are enabled, so nothing will be indexed.</p>
      )}
    </fieldset>
  );
}

function ServerCard({ server, onChanged }: { server: Server; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showLibraries = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    try {
      setLibraries(await api<Library[]>('GET', `/admin/servers/${server.id}/libraries`));
      setOpen(true);
    } catch (err) {
      setError(messageFor(err));
    }
  };

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api('PATCH', `/admin/servers/${server.id}`, { enabled });
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'SERVER_VALIDATION_FAILED'
          ? `${err.message} The server was not changed.`
          : messageFor(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const revalidate = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/admin/servers/${server.id}/validate`);
      onChanged();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const disabled = server.status === 'disabled';
  return (
    <article className="server-card">
      <header>
        <h2>{server.name}</h2>
        <span className="type-tag">{server.type}</span>
      </header>
      <p className="mono-url">{server.baseUrl}</p>
      <p className={`status status-${server.status}`}>{STATUS_TEXT[server.status]}</p>
      <dl className="stats">
        <div>
          <dt>Libraries</dt>
          <dd>
            {server.enabledLibraryCount} of {server.libraryCount} enabled
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{server.version ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{server.priority}</dd>
        </div>
      </dl>
      <Alert message={error} />
      {server.enabledLibraryCount === 0 && server.status === 'active' && (
        <p className="helper">No libraries are enabled, so nothing is indexed from this server.</p>
      )}
      {open && libraries && <Libraries serverId={server.id} initial={libraries} />}
      <div className="form-actions">
        <button
          className="button"
          type="button"
          aria-label={`${open ? 'Hide' : 'Show'} libraries of ${server.name}`}
          onClick={() => void showLibraries()}
        >
          Libraries
        </button>
        {server.status === 'pending_validation' && (
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void revalidate()}
          >
            Retry setup
          </button>
        )}
        <button
          className="button"
          type="button"
          disabled={busy}
          aria-label={`${disabled ? 'Enable' : 'Disable'} ${server.name}`}
          onClick={() => void setEnabled(disabled)}
        >
          {disabled ? 'Enable' : 'Disable'}
        </button>
      </div>
    </article>
  );
}
