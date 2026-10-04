import { useState } from 'react';
import type { PasskeySummary } from '@cinewren/shared';
import { api } from '../api-client';
import { Alert } from '../components/ui';
import { useLoad } from '../lib/useLoad';
import {
  createPasskey,
  isCancelled,
  messageFor,
  PASSKEY_CANCELLED,
  reauthenticate,
} from './ceremony';

type Step = 'idle' | 'confirming' | 'creating';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function passkeyName(p: PasskeySummary): string {
  return p.label ?? 'Passkey';
}

/**
 * Settings → Passkeys (FR-USR-006, UX §5): list, add and remove the user's own passkeys. Adding
 * first confirms it's the user with a passkey they already have (T5.8 SR-04), then creates the new
 * one; a stolen session alone cannot add a passkey.
 */
export function PasskeysSection() {
  const { state, reload } = useLoad(() => api<PasskeySummary[]>('GET', '/me/passkeys'), 'passkeys');
  const [label, setLabel] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const add = async () => {
    setError(null);
    setNotice(null);
    setRemoving(null);
    try {
      setStep('confirming');
      await reauthenticate();
      setStep('creating');
      const added = await createPasskey(label.trim() || undefined);
      setLabel('');
      setNotice(`${passkeyName(added)} added.`);
      reload();
    } catch (err) {
      if (isCancelled(err)) setNotice(PASSKEY_CANCELLED);
      else setError(messageFor(err));
    } finally {
      setStep('idle');
    }
  };

  const remove = async (p: PasskeySummary) => {
    setRemoveBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('DELETE', `/me/passkeys/${encodeURIComponent(p.id)}`);
      setNotice(`${passkeyName(p)} removed. Sessions signed in with it have ended.`);
      setRemoving(null);
      reload();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setRemoveBusy(false);
    }
  };

  const busy = step !== 'idle';
  const passkeys = state.status === 'ready' ? state.data : [];
  const onlyOne = passkeys.length === 1;

  return (
    <section aria-labelledby="passkeys-h" className="stack">
      <h2 id="passkeys-h" className="h-section">
        Passkeys
      </h2>
      {state.status === 'loading' && <p className="helper">Loading passkeys…</p>}
      {state.status === 'error' && <Alert message={state.message} onRetry={reload} />}
      {state.status === 'ready' && (
        <ul className="passkey-list">
          {passkeys.map((p) => (
            <li key={p.id} className="passkey-row">
              <div>
                <p className="passkey-name">{passkeyName(p)}</p>
                <p className="helper">Added {dateFormat.format(new Date(p.createdAt))}</p>
              </div>
              {removing?.id === p.id ? (
                <div className="actions">
                  <button
                    type="button"
                    className="button button-primary"
                    disabled={removeBusy}
                    onClick={() => void remove(p)}
                  >
                    {removeBusy ? 'Removing…' : `Remove ${passkeyName(p)}`}
                  </button>
                  <button
                    type="button"
                    className="button button-outline"
                    disabled={removeBusy}
                    onClick={() => {
                      setRemoving(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="button button-outline"
                  disabled={onlyOne || busy}
                  aria-describedby={onlyOne ? 'passkey-last-reason' : undefined}
                  onClick={() => {
                    setNotice(null);
                    setError(null);
                    setRemoving(p);
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {onlyOne && (
        <p id="passkey-last-reason" className="helper">
          Add another passkey first. You can&apos;t remove your only one.
        </p>
      )}
      {removing && (
        <p className="helper" role="status">
          Remove {passkeyName(removing)}? Any session signed in with it ends.
        </p>
      )}
      <div className="field">
        <label htmlFor="new-passkey-label">Name your new passkey (optional)</label>
        <input
          id="new-passkey-label"
          maxLength={64}
          placeholder="For example, Work laptop"
          value={label}
          disabled={busy}
          onChange={(e) => {
            setLabel(e.target.value);
          }}
        />
      </div>
      <div>
        <button
          type="button"
          className="button button-outline"
          disabled={busy}
          onClick={() => void add()}
        >
          {step === 'confirming'
            ? 'Confirm it’s you…'
            : step === 'creating'
              ? 'Creating passkey…'
              : 'Add passkey'}
        </button>
      </div>
      {step === 'confirming' && (
        <p className="helper" role="status">
          Confirm it’s you: use a passkey you already have.
        </p>
      )}
      {step === 'creating' && (
        <p className="helper" role="status">
          Now create the new passkey.
        </p>
      )}
      {step === 'idle' && !error && !notice && (
        <p className="helper">
          You&apos;ll confirm it&apos;s you with a passkey you already have first.
        </p>
      )}
      <Alert message={error} />
      {notice && (
        <p className="helper" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
