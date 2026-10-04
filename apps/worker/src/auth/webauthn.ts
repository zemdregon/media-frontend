/**
 * WebAuthn ceremonies and the challenge store (IR-006, NFR-SEC-007, TDD §5.1), on
 * `@simplewebauthn/server`, which runs in the Workers runtime on WebCrypto.
 * Discoverable credentials, user verification required, attestation `none`.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { AppError } from '../api/errors';
import {
  blobToBytes,
  consumeChallenge,
  insertChallenge,
  type ChallengePurpose,
  type ChallengeRow,
  type PasskeyRow,
} from '../db/auth';
import type { Config } from '../platform/config';
import { ulid } from '../platform/ids';
import type { Logger } from '../platform/logger';

/** One generic failure for every ceremony problem (LLD-ERR). */
export function ceremonyFailed(status: 400 | 401 = 400): AppError {
  return new AppError(
    'WEBAUTHN_VERIFICATION_FAILED',
    "Passkey step didn't finish. Nothing was saved. Try again.",
    undefined,
    status,
  );
}

export interface RegistrationSubject {
  /** The user's ID; it becomes the WebAuthn user handle. */
  userId: string;
  displayName: string;
  excludeCredentialIds: string[];
}

export async function registrationOptions(
  config: Config,
  subject: RegistrationSubject,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: subject.displayName,
    userDisplayName: subject.displayName,
    userID: new Uint8Array(new TextEncoder().encode(subject.userId)),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: subject.excludeCredentialIds.map((id) => ({ id })),
    timeout: config.challengeTtlMs,
  });
}

export async function authenticationOptions(
  config: Config,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  // No allowCredentials: discoverable login needs no username (LLD-API).
  return generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: 'required',
    timeout: config.challengeTtlMs,
  });
}

/** Stores a single-use challenge bound to a purpose (and invite or user). Returns its handle. */
export async function storeChallenge(
  db: D1Database,
  config: Config,
  purpose: ChallengePurpose,
  challenge: string,
  binding: { inviteId?: string; userId?: string; id?: string } = {},
): Promise<string> {
  const id = binding.id ?? ulid();
  await insertChallenge(db, {
    id,
    challenge,
    purpose,
    invite_id: binding.inviteId ?? null,
    user_id: binding.userId ?? null,
    expires_at: Date.now() + config.challengeTtlMs,
  });
  return id;
}

/**
 * Consumes a challenge: deleted first, then checked for expiry and purpose, so it is single-use
 * even when verification fails (LLD-TOKEN).
 */
export async function takeChallenge(
  db: D1Database,
  id: string,
  purposes: ChallengePurpose[],
  failStatus: 400 | 401 = 400,
): Promise<ChallengeRow> {
  const row = await consumeChallenge(db, id);
  if (!row || row.expires_at <= Date.now() || !purposes.includes(row.purpose)) {
    throw ceremonyFailed(failStatus);
  }
  return row;
}

export interface VerifiedPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
  aaguid: string | null;
  backedUp: boolean;
}

export async function verifyRegistration(
  config: Config,
  logger: Logger,
  response: unknown,
  challenge: string,
): Promise<VerifiedPasskey> {
  try {
    const result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
    });
    if (!result.verified) throw new Error('not verified');
    const { credential, aaguid, credentialBackedUp } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: credential.publicKey,
      signCount: credential.counter,
      transports: credential.transports ?? [],
      aaguid,
      backedUp: credentialBackedUp,
    };
  } catch (err) {
    logger.info('auth.register.failed', { error: err });
    throw ceremonyFailed(400);
  }
}

/** Verifies an assertion; returns the new sign count. Counter regressions are rejected. */
export async function verifyAuthentication(
  config: Config,
  logger: Logger,
  response: unknown,
  challenge: string,
  passkey: PasskeyRow,
): Promise<number> {
  try {
    const result = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: config.appOrigin,
      expectedRPID: config.rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: blobToBytes(passkey.public_key),
        counter: passkey.sign_count,
        transports: JSON.parse(passkey.transports) as string[],
      },
    });
    if (!result.verified) throw new Error('not verified');
    return result.authenticationInfo.newCounter;
  } catch (err) {
    const counter = err instanceof Error && /counter/i.test(err.message);
    logger.warn(counter ? 'auth.passkey.counter_regression' : 'auth.login.failed', {
      passkey_id: passkey.id,
      error: err,
    });
    throw ceremonyFailed(401);
  }
}
