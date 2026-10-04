import type { CDPSession, Page } from '@playwright/test';

/**
 * Adds a Chromium CDP virtual authenticator to the page's context (TDD §5.1), so the setup and
 * sign-in ceremonies run the real `navigator.credentials` flow and the Worker verifies real
 * signatures. Returns the session so the caller can remove it.
 */
export async function addVirtualAuthenticator(page: Page): Promise<CDPSession> {
  return (await addAuthenticator(page)).cdp;
}

/** The credential as CDP reports it, so a later spec can import it into a fresh authenticator. */
export type VirtualCredential = Record<string, unknown>;

/** Like `addVirtualAuthenticator`, but also returns the authenticator ID and can import credentials. */
export async function addAuthenticator(
  page: Page,
  credentials: VirtualCredential[] = [],
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  for (const credential of credentials) {
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential } as never);
  }
  return { cdp, authenticatorId };
}

/** Every credential the authenticator holds (the journey hands its passkey to the a11y spec). */
export async function exportCredentials(
  cdp: CDPSession,
  authenticatorId: string,
): Promise<VirtualCredential[]> {
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  return credentials as unknown as VirtualCredential[];
}
