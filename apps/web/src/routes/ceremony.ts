import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { CeremonyOptions, UserSummary } from '@cinewren/shared';
import { api, ApiError } from '../api-client';

type CreationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type RequestOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

export const PASSKEY_FAILED = "Passkey step didn't finish. Nothing was saved. Try again.";

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

export async function signIn(): Promise<UserSummary> {
  const { challengeId, options } = await api<CeremonyOptions<RequestOptions>>(
    'POST',
    '/auth/login/options',
  );
  const response = await startAuthentication({ optionsJSON: options });
  return (await api<{ user: UserSummary }>('POST', '/auth/login/verify', { challengeId, response }))
    .user;
}
