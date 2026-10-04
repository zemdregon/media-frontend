import { useId, useState, type SyntheticEvent } from 'react';
import { DISPLAY_NAME_MAX, type AdminUser, type Invite, type Role } from '@cinewren/shared';
import {
  createInvite,
  deleteUser,
  listEnabledLibraries,
  listInvites,
  listUsers,
  reenrollUser,
  revokeInvite,
  setGrants,
  updateUser,
  type GrantableLibrary,
} from '../api-client/users';
import { Dialog } from '../components/Dialog';
import { Alert, EmptyState, PageHead, Segmented, SkeletonBlock, StatusDot } from '../components/ui';
import { Link } from '../lib/router';
import { errorMessage, useLoad, usePagedLoad } from '../lib/useLoad';

/**
 * Operator "Users and invites" (UX §5; FR-USR-004, FR-USR-005, FR-USR-007, FR-USR-008, BR-8).
 * People: access, re-enrolment link, disable and delete. Invites: single-use links. Every link is
 * shown once, in a dialog, and is never stored or logged here.
 */

type Tab = 'people' | 'invites';

const ROLE_LABEL: Record<Role, string> = { operator: 'Operator', viewer: 'Viewer' };
const LAST_OPERATOR_REASON = 'This is the last operator. Make someone else an operator first.';

const formatTime = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function accessSummary(user: AdminUser, libraries: GrantableLibrary[] | null): string {
  if (user.role === 'operator') return 'All libraries';
  if (!libraries) return `${String(user.libraryIds.length)} libraries`;
  const granted = libraries.filter((l) => user.libraryIds.includes(l.id)).length;
  if (granted === 0) return 'No libraries';
  return `${String(granted)} of ${String(libraries.length)} libraries`;
}

export function Users() {
  const [tab, setTab] = useState<Tab>('people');
  const [notice, setNotice] = useState<string | null>(null);
  const libraries = useLoad(listEnabledLibraries, 'users:libraries');

  return (
    <>
      <PageHead
        title="Users and invites"
        aside={
          <Link to="/servers" className="button button-outline">
            Back to Servers
          </Link>
        }
      />
      <p className="helper">
        Invite people, choose which libraries they can see and manage their accounts. Cinewren sends
        no email, so you pass each link on yourself.
      </p>
      <Segmented<Tab>
        legend="Section"
        hideLegend
        value={tab}
        options={[
          { value: 'people', label: 'People' },
          { value: 'invites', label: 'Invites' },
        ]}
        onChange={(t) => {
          setTab(t);
          setNotice(null);
        }}
      />
      <Alert tone="info" message={notice} />
      {tab === 'people' ? (
        <PeopleTab
          libraries={libraries.state.status === 'ready' ? libraries.state.data : null}
          librariesFailed={libraries.state.status === 'error'}
          onNotice={setNotice}
        />
      ) : (
        <InvitesTab
          libraries={libraries.state.status === 'ready' ? libraries.state.data : null}
          onNotice={setNotice}
        />
      )}
    </>
  );
}

type PeopleDialog =
  | { kind: 'access'; user: AdminUser }
  | { kind: 'delete'; user: AdminUser }
  | { kind: 'link'; user: AdminUser; link: string; expiresAt: number };

function PeopleTab({
  libraries,
  librariesFailed,
  onNotice,
}: {
  libraries: GrantableLibrary[] | null;
  librariesFailed: boolean;
  onNotice: (message: string | null) => void;
}) {
  const paged = usePagedLoad((cursor) => listUsers(cursor), 'users:people');
  const [dialog, setDialog] = useState<PeopleDialog | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // BR-8: with every user loaded, the only active operator cannot be disabled or deleted. The
  // server enforces it too (409 LAST_OPERATOR) and its reason is shown if this view was stale.
  const activeOperators = paged.items.filter((u) => u.role === 'operator' && u.status === 'active');
  const isLastOperator = (u: AdminUser) =>
    !paged.cursor && activeOperators.length === 1 && activeOperators[0]?.id === u.id;

  const act = async (user: AdminUser, fn: () => Promise<void>) => {
    setBusyId(user.id);
    setError(null);
    onNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const toggleStatus = (user: AdminUser) =>
    act(user, async () => {
      const disabling = user.status !== 'disabled';
      await updateUser(user.id, { status: disabling ? 'disabled' : 'active' });
      onNotice(
        disabling
          ? `Disabled ${user.displayName}. Their sessions ended.`
          : `Enabled ${user.displayName}.`,
      );
      paged.reload();
    });

  const reenroll = (user: AdminUser) =>
    act(user, async () => {
      const r = await reenrollUser(user.id);
      setDialog({ kind: 'link', user, link: r.link, expiresAt: r.expiresAt });
    });

  return (
    <>
      <Alert message={error} />
      {librariesFailed && (
        <Alert
          tone="info"
          message="Couldn't load the library list, so access is shown as a count and can't be edited yet."
        />
      )}
      {paged.state.status === 'loading' && <SkeletonBlock label="Loading people" />}
      {paged.state.status === 'error' && (
        <Alert message={paged.state.message} onRetry={paged.reload} />
      )}
      {paged.state.status === 'ready' &&
        (paged.items.length === 0 ? (
          <EmptyState title="No people yet">Invite someone from the Invites tab.</EmptyState>
        ) : (
          <>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="People table">
              <table className="copies users-table">
                <caption className="sr-only">People with an account</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Library access</th>
                    <th scope="col">Status</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.items.map((u) => (
                    <PersonRow
                      key={u.id}
                      user={u}
                      libraries={libraries}
                      busy={busyId === u.id}
                      last={isLastOperator(u)}
                      onEditAccess={() => {
                        setDialog({ kind: 'access', user: u });
                      }}
                      onReenroll={() => void reenroll(u)}
                      onToggle={() => void toggleStatus(u)}
                      onDelete={() => {
                        setDialog({ kind: 'delete', user: u });
                      }}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <Alert message={paged.moreError} />
            {paged.cursor && (
              <div className="center">
                <button
                  type="button"
                  className="button button-outline"
                  disabled={paged.busy}
                  aria-busy={paged.busy}
                  onClick={() => void paged.loadMore()}
                >
                  {paged.busy ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        ))}
      {dialog?.kind === 'access' && libraries && (
        <AccessDialog
          user={dialog.user}
          libraries={libraries}
          onClose={() => {
            setDialog(null);
          }}
          onSaved={() => {
            onNotice(`Saved library access for ${dialog.user.displayName}.`);
            setDialog(null);
            paged.reload();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          user={dialog.user}
          onClose={() => {
            setDialog(null);
          }}
          onDeleted={() => {
            onNotice(`Deleted ${dialog.user.displayName}.`);
            setDialog(null);
            paged.reload();
          }}
        />
      )}
      {dialog?.kind === 'link' && (
        <Dialog
          title={`Re-enrol link for ${dialog.user.displayName}`}
          onClose={() => {
            setDialog(null);
          }}
        >
          <LinkPanel
            link={dialog.link}
            expiresAt={dialog.expiresAt}
            intro={`Send this to ${dialog.user.displayName}. Opening it lets them add a new passkey. It works once.`}
            onDone={() => {
              setDialog(null);
            }}
          />
        </Dialog>
      )}
    </>
  );
}

function PersonRow({
  user: u,
  libraries,
  busy,
  last,
  onEditAccess,
  onReenroll,
  onToggle,
  onDelete,
}: {
  user: AdminUser;
  libraries: GrantableLibrary[] | null;
  busy: boolean;
  last: boolean;
  onEditAccess: () => void;
  onReenroll: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const reasonId = useId();
  const name = u.displayName;
  const protectedUser = last && u.status === 'active';
  const tone = u.status === 'active' ? 'ok' : u.status === 'invited' ? 'warn' : 'muted';
  return (
    <tr>
      <th scope="row">{name}</th>
      <td>
        <span className="type-tag">{ROLE_LABEL[u.role]}</span>
      </td>
      <td>{accessSummary(u, libraries)}</td>
      <td>
        <StatusDot
          tone={tone}
          label={u.status === 'active' ? 'Active' : u.status === 'invited' ? 'Invited' : 'Disabled'}
        />
      </td>
      <td>
        <div className="row-actions">
          {u.role === 'viewer' && (
            <button
              type="button"
              className="button button-outline"
              disabled={busy || !libraries}
              aria-label={`Edit access for ${name}`}
              onClick={onEditAccess}
            >
              Edit access
            </button>
          )}
          {u.status !== 'invited' && (
            <button
              type="button"
              className="button button-outline"
              disabled={busy}
              aria-label={`Re-enrol link for ${name}`}
              onClick={onReenroll}
            >
              Re-enrol link
            </button>
          )}
          {u.status !== 'invited' && (
            <button
              type="button"
              className="button button-outline"
              disabled={busy || protectedUser}
              aria-label={`${u.status === 'disabled' ? 'Enable' : 'Disable'} ${name}`}
              {...(protectedUser ? { 'aria-describedby': reasonId } : {})}
              onClick={onToggle}
            >
              {u.status === 'disabled' ? 'Enable' : 'Disable'}
            </button>
          )}
          <button
            type="button"
            className="button button-outline"
            disabled={busy || protectedUser}
            aria-label={`Delete ${name}`}
            {...(protectedUser ? { 'aria-describedby': reasonId } : {})}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
        {protectedUser && (
          <p id={reasonId} className="helper">
            {LAST_OPERATOR_REASON}
          </p>
        )}
      </td>
    </tr>
  );
}

function LibraryChecklist({
  libraries,
  checked,
  onToggle,
}: {
  libraries: GrantableLibrary[];
  checked: (id: string) => boolean;
  onToggle: (id: string, on: boolean) => void;
}) {
  if (libraries.length === 0) {
    return <p className="helper">No libraries are enabled yet. Enable some on the Servers page.</p>;
  }
  return (
    <fieldset className="libraries">
      <legend className="mono-label">Libraries</legend>
      {libraries.map((l) => (
        <label key={l.id} className="check">
          <input
            type="checkbox"
            checked={checked(l.id)}
            onChange={(e) => {
              onToggle(l.id, e.target.checked);
            }}
          />
          {l.name}{' '}
          <span className="helper">
            {l.kind === 'tv' ? 'TV' : 'Movies'} on {l.serverName}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** FR-USR-005: replaces a viewer's library grants. Grants to libraries not listed are kept. */
function AccessDialog({
  user,
  libraries,
  onClose,
  onSaved,
}: {
  user: AdminUser;
  libraries: GrantableLibrary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const known = new Set(libraries.map((l) => l.id));
  const [selected, setSelected] = useState(
    () => new Set(user.libraryIds.filter((id) => known.has(id))),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (e: SyntheticEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const kept = user.libraryIds.filter((id) => !known.has(id));
      await setGrants(user.id, [...selected, ...kept]);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`Library access for ${user.displayName}`} onClose={onClose}>
      <form onSubmit={(e) => void save(e)}>
        <LibraryChecklist
          libraries={libraries}
          checked={(id) => selected.has(id)}
          onToggle={(id, on) => {
            setSelected((cur) => {
              const next = new Set(cur);
              if (on) next.add(id);
              else next.delete(id);
              return next;
            });
          }}
        />
        <Alert message={error} />
        <div className="form-actions">
          <button type="submit" className="button button-primary-inline" disabled={busy}>
            {busy ? 'Saving…' : 'Save access'}
          </button>
          <button type="button" className="button button-outline" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** FR-USR-008: names the person; the server refuses the last operator (BR-8). */
function DeleteDialog({
  user,
  onClose,
  onDeleted,
}: {
  user: AdminUser;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteUser(user.id);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title={`Delete ${user.displayName}?`} onClose={onClose}>
      <p className="helper">
        This removes {user.displayName}&apos;s account, passkeys, sessions and watch progress. It
        can&apos;t be undone.
      </p>
      <Alert message={error} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-primary-inline"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? 'Deleting…' : `Delete ${user.displayName}`}
        </button>
        <button type="button" className="button button-outline" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

/** A single-use link with Copy and its expiry. The read-only field is the fallback for Copy. */
function LinkPanel({
  link,
  expiresAt,
  intro,
  onDone,
}: {
  link: string;
  expiresAt: number;
  intro: string;
  onDone: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const inputId = useId();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setStatus('Link copied.');
    } catch {
      setStatus("Couldn't copy automatically. Select the link and copy it.");
    }
  };

  return (
    <>
      <p className="helper">{intro}</p>
      <div className="field">
        <label htmlFor={inputId}>Single-use link</label>
        <div className="copy-row">
          <input
            id={inputId}
            readOnly
            value={link}
            onFocus={(e) => {
              e.currentTarget.select();
            }}
          />
          <button
            type="button"
            className="button button-primary-inline"
            onClick={() => void copy()}
          >
            Copy
          </button>
        </div>
      </div>
      <p className="helper">
        Expires {formatTime(expiresAt)}. It&apos;s shown only now, so copy it before you close this.
      </p>
      <div role="status" aria-live="polite" className="helper">
        {status}
      </div>
      <div className="form-actions">
        <button type="button" className="button button-outline" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}

function InvitesTab({
  libraries,
  onNotice,
}: {
  libraries: GrantableLibrary[] | null;
  onNotice: (message: string | null) => void;
}) {
  const paged = usePagedLoad((cursor) => listInvites({ status: 'open', cursor }), 'users:invites');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revoke = async (invite: Invite) => {
    setBusyId(invite.id);
    setError(null);
    onNotice(null);
    try {
      await revokeInvite(invite.id);
      onNotice(`Revoked the invite for ${invite.displayName}.`);
      paged.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div className="actions">
        <button
          type="button"
          className="button button-primary-inline"
          onClick={() => {
            setCreating(true);
          }}
        >
          New invite
        </button>
      </div>
      <Alert message={error} />
      {paged.state.status === 'loading' && <SkeletonBlock label="Loading invites" />}
      {paged.state.status === 'error' && (
        <Alert message={paged.state.message} onRetry={paged.reload} />
      )}
      {paged.state.status === 'ready' &&
        (paged.items.length === 0 ? (
          <EmptyState title="No open invites">
            Create an invite to give someone an account. Each link works once.
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Open invites table">
              <table className="copies users-table">
                <caption className="sr-only">Open invites</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">For</th>
                    <th scope="col">Role</th>
                    <th scope="col">Expires</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.items.map((i) => (
                    <tr key={i.id}>
                      <th scope="row">{i.displayName}</th>
                      <td>{i.kind === 'reenroll' ? 'New passkey' : 'New account'}</td>
                      <td>
                        <span className="type-tag">{ROLE_LABEL[i.role]}</span>
                      </td>
                      <td>{formatTime(i.expiresAt)}</td>
                      <td>
                        <button
                          type="button"
                          className="button button-outline"
                          disabled={busyId === i.id}
                          aria-label={`Revoke the invite for ${i.displayName}`}
                          onClick={() => void revoke(i)}
                        >
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Alert message={paged.moreError} />
            {paged.cursor && (
              <div className="center">
                <button
                  type="button"
                  className="button button-outline"
                  disabled={paged.busy}
                  aria-busy={paged.busy}
                  onClick={() => void paged.loadMore()}
                >
                  {paged.busy ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        ))}
      {creating && (
        <InviteDialog
          libraries={libraries}
          onClose={() => {
            setCreating(false);
            paged.reload();
          }}
        />
      )}
    </>
  );
}

/** FR-USR-004, FR-USR-005: name, role and libraries (all enabled by default), then the one-time link. */
function InviteDialog({
  libraries,
  onClose,
}: {
  libraries: GrantableLibrary[] | null;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  // Every enabled library starts checked, so only the ones the operator turns off are tracked.
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ link: string; expiresAt: number } | null>(null);
  const nameId = useId();

  const submit = async (e: SyntheticEvent) => {
    e.preventDefault();
    const displayName = name.trim();
    if (!displayName) {
      setError('Enter a display name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await createInvite({
        displayName,
        role,
        ...(role === 'viewer' && libraries && libraries.length > 0
          ? { libraryIds: libraries.filter((l) => !unchecked.has(l.id)).map((l) => l.id) }
          : {}),
      });
      setCreated({ link: r.link, expiresAt: r.expiresAt });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Dialog title="Invite created" onClose={onClose} focusKey="link">
        <LinkPanel
          link={created.link}
          expiresAt={created.expiresAt}
          intro={`Send this to ${name.trim()}. Opening it lets them create a passkey and sign in. It works once.`}
          onDone={onClose}
        />
      </Dialog>
    );
  }

  return (
    <Dialog title="New invite" onClose={onClose} focusKey="form">
      <form onSubmit={(e) => void submit(e)}>
        <div className="field">
          <label htmlFor={nameId}>Display name</label>
          <input
            id={nameId}
            value={name}
            maxLength={DISPLAY_NAME_MAX}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </div>
        <Segmented<Role>
          legend="Role"
          value={role}
          options={[
            { value: 'viewer', label: 'Viewer' },
            { value: 'operator', label: 'Operator' },
          ]}
          onChange={setRole}
        />
        {role === 'operator' ? (
          <p className="helper">Operators manage Cinewren and see every enabled library.</p>
        ) : (
          libraries && (
            <LibraryChecklist
              libraries={libraries}
              checked={(id) => !unchecked.has(id)}
              onToggle={(id, on) => {
                setUnchecked((cur) => {
                  const next = new Set(cur);
                  if (on) next.delete(id);
                  else next.add(id);
                  return next;
                });
              }}
            />
          )
        )}
        <Alert message={error} />
        <div className="form-actions">
          <button type="submit" className="button button-primary-inline" disabled={busy}>
            {busy ? 'Creating…' : 'Create invite'}
          </button>
          <button type="button" className="button button-outline" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
