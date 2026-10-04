import type { CDPSession, Page } from '@playwright/test';

/**
 * Adds a Chromium CDP virtual authenticator to the page's context (TDD §5.1), so the setup and
 * sign-in ceremonies run the real `navigator.credentials` flow and the Worker verifies real
 * signatures. Returns the session so the caller can remove it.
 */
export async function addVirtualAuthenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return cdp;
}
