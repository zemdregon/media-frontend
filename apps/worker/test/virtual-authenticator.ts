/**
 * A software WebAuthn authenticator for tests (T0.5). It holds P-256 key pairs made with
 * WebCrypto and produces `none`-attestation registration responses and ES256 assertions in the
 * JSON shapes `@simplewebauthn/browser` sends, so the Worker verifies them with the real
 * `@simplewebauthn/server` code path inside the Workers runtime.
 */
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';

interface StoredCredential {
  id: Bytes;
  rpId: string;
  userHandle: string;
  keyPair: CryptoKeyPair;
  signCount: number;
}

const enc = new TextEncoder();
const utf8 = (s: string): Bytes => new Uint8Array(enc.encode(s));

type Bytes = Uint8Array<ArrayBuffer>;

async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

/** WebCrypto ECDSA returns raw r||s; WebAuthn ES256 signatures are ASN.1 DER. */
function rawToDer(raw: Uint8Array): Bytes {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if ((v[0] ?? 0) & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export class VirtualAuthenticator {
  readonly credentials: StoredCredential[] = [];

  /** Answers `navigator.credentials.create()` for the given options. */
  async register(
    options: PublicKeyCredentialCreationOptionsJSON,
    origin: string,
    overrides: { rpId?: string; challenge?: string } = {},
  ): Promise<RegistrationResponseJSON> {
    const rpId = overrides.rpId ?? options.rp.id ?? new URL(origin).hostname;
    const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
    const coseKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, isoBase64URL.toBuffer(jwk.x ?? '')],
        [-3, isoBase64URL.toBuffer(jwk.y ?? '')],
      ]),
    );
    const id = crypto.getRandomValues(new Uint8Array(16));
    const authData = concat(
      await sha256(enc.encode(rpId)),
      new Uint8Array([FLAG_UP | FLAG_UV | FLAG_AT]),
      u32(0),
      new Uint8Array(16), // AAGUID: zeros for a software authenticator
      new Uint8Array([0, id.length]),
      id,
      coseKey,
    );
    const attestationObject = isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<string, string>>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, string>()],
        ['authData', authData],
      ]),
    );
    const clientDataJSON = utf8(
      JSON.stringify({
        type: 'webauthn.create',
        challenge: overrides.challenge ?? options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    this.credentials.push({ id, rpId, userHandle: options.user.id, keyPair, signCount: 0 });
    const credId = isoBase64URL.fromBuffer(id);
    return {
      id: credId,
      rawId: credId,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ['internal'],
      },
    };
  }

  /** Answers `navigator.credentials.get()` with a discoverable credential for the RP. */
  async authenticate(
    options: PublicKeyCredentialRequestOptionsJSON,
    origin: string,
    which = 0,
  ): Promise<AuthenticationResponseJSON> {
    const rpId = options.rpId ?? new URL(origin).hostname;
    const cred = this.credentials.filter((c) => c.rpId === rpId)[which];
    if (!cred) throw new Error('No credential for this RP');
    cred.signCount += 1;
    const authData = concat(
      await sha256(enc.encode(rpId)),
      new Uint8Array([FLAG_UP | FLAG_UV]),
      u32(cred.signCount),
    );
    const clientDataJSON = utf8(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: options.challenge,
        origin,
        crossOrigin: false,
      }),
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cred.keyPair.privateKey, signed),
    );
    const credId = isoBase64URL.fromBuffer(cred.id);
    return {
      id: credId,
      rawId: credId,
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(rawToDer(raw)),
        userHandle: cred.userHandle,
      },
    };
  }
}
