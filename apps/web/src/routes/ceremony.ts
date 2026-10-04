import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { CeremonyOptions, PasskeySummary, ReauthResult, UserSummary } from '@cinewren/shared';
import { api, ApiError } from '../api-client';

type CreationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type RequestOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

export const PASSKEY_FAILED = "Passkey step didn't finish. Nothing was saved. Try again.";
export const PASSKEY_CANCELLED = 'Passkey step cancelled. Nothing was saved.';

/** The browser reports a dismissed or timed-out passkey prompt as `NotAllowedError`. */
export function isCancelled(err: unknown): boolean {
  return err instanceof Error && err.name === 'NotAllowedError';
}

/** Message for any failure: API errors carry safe copy; browser ceremony errors get one line. */
export function messageFor(err: unknown): string {
  return err instanceof ApiError ? err.message : PASSKEY_FAILED;
}

/** options → navigator.credentials.create → verify, for setup, invite redemption or add-passkey. */
export async function register(
  optionsPath: string,
  verifyPath: string,
  body: Record<string, unknown>,
): Promise<{ user?: UserSummary }> {
  const { challengeId, options } = await api<CeremonyOptions<CreationOptions>>(
    'POST',
    optionsPath,
    body,
  );
  const response = await startRegistration({ optionsJSON: options });
  return api('POST', verifyPath, { ...body, challengeId, response });
}

/** Confirms it's the signed-in user with one of their passkeys (SR-04); needed before adding one. */
export async function reauthenticate(): Promise<ReauthResult> {
  const { challengeId, options } = await api<CeremonyOptions<RequestOptions>>(
    'POST',
    '/me/reauth/options',
  );
  const response = await startAuthentication({ optionsJSON: options });
  return api<ReauthResult>('POST', '/me/reauth/verify', { challengeId, response });
}

/** Registers a new passkey for the signed-in user; the session must be freshly re-authenticated. */
export async function createPasskey(label: string | undefined): Promise<PasskeySummary> {
  const body = label ? { label } : {};
  const { challengeId, options } = await api<CeremonyOptions<CreationOptions>>(
    'POST',
    '/me/passkeys/options',
    body,
  );
  const response = await startRegistration({ optionsJSON: options });
  return (
    await api<{ passkey: PasskeySummary }>('POST', '/me/passkeys/verify', {
      ...body,
      challengeId,
      response,
    })
  ).passkey;
}

export async function signIn(): Promise<UserSummary> {
  const { challengeId, options } = await api<CeremonyOptions<RequestOptions>>(
    'POST',
    '/auth/login/options',
  );
  const response = await startAuthentication({ optionsJSON: options });
  return (await api<{ user: UserSummary }>('POST', '/auth/login/verify', { challengeId, response }))
    .user;
}
