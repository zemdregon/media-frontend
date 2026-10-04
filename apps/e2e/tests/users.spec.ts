/**
 * T2.6 operator "Users and invites" screen, driven through the UI only (FR-USR-004, FR-USR-005,
 * FR-USR-008, BR-8): list people, create an invite, redeem it in a second browser with its own
 * virtual authenticator, edit the viewer's library access, disable the viewer, revoke a second
 * invite, and see the sole operator protected.
 *
 * Runs after journey.spec.ts and ui-a11y.spec.ts on the same database (spec files run in name
 * order, one worker). The a11y spec hands over the operator's passkey with its current signature counter.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { addAuthenticator, type VirtualCredential } from '../support/authenticator';
import { BASE_URL, HANDOFF_FILE, OPERATOR_NAME } from '../support/env';

test.describe.configure({ mode: 'serial' });

const VIEWER = 'E2E Viewer';
const REVOKED = 'E2E Revoked Guest';

let page: Page;
let authenticator: Awaited<ReturnType<typeof addAuthenticator>> | undefined;
let inviteLink = '';

test.beforeAll(async ({ browser }) => {
  const handoff = JSON.parse(readFileSync(HANDOFF_FILE, 'utf8')) as {
    credentials: VirtualCredential[];
  };
  const context = await browser.newContext();
  page = await context.newPage();
  authenticator = await addAuthenticator(page, handoff.credentials);
  await page.goto('/');
  await page.getByRole('button', { name: 'Use your passkey' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
});

test.afterAll(async () => {
  await authenticator?.cdp.detach().catch(() => undefined);
  await page.context().close();
});

const peopleTable = () => page.getByRole('table', { name: 'People with an account' });

/** Creates an invite through the dialog and returns the link from the read-only field. */
async function createInvite(name: string): Promise<{ link: string; expires: string }> {
  await page.getByRole('button', { name: 'New invite' }).click();
  const dialog = page.getByRole('dialog', { name: 'New invite' });
  await dialog.getByLabel('Display name').fill(name);
  await expect(dialog.getByRole('radio', { name: 'Viewer' })).toBeChecked();
  // Every enabled library starts selected.
  await expect(dialog.getByRole('checkbox', { name: /Movies/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Shows/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Create invite' }).click();
  const done = page.getByRole('dialog', { name: 'Invite created' });
  const link = await done.getByLabel('Single-use link').inputValue();
  const expires = (await done.getByText(/^Expires /).textContent()) ?? '';
  await done.getByRole('button', { name: 'Done' }).click();
  await expect(done).toBeHidden();
  return { link, expires };
}

test('Servers links to Users and invites, and People lists the operator', async () => {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Servers' })
    .click();
  await page.getByRole('link', { name: 'Users and invites' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Users and invites' })).toBeVisible();
  const row = peopleTable().getByRole('row', { name: new RegExp(OPERATOR_NAME) });
  await expect(row.getByText('Operator', { exact: true })).toBeVisible();
  await expect(row.getByText('All libraries')).toBeVisible();
  await expect(row.getByText('Active')).toBeVisible();
});

test('the sole operator cannot be disabled or deleted, and the reason is shown', async () => {
  await expect(page.getByRole('button', { name: `Disable ${OPERATOR_NAME}` })).toBeDisabled();
  await expect(page.getByRole('button', { name: `Delete ${OPERATOR_NAME}` })).toBeDisabled();
  await expect(
    page.getByText('This is the last operator. Make someone else an operator first.'),
  ).toBeVisible();
});

test('a new viewer invite shows a single-use link with its expiry', async () => {
  await page.getByRole('radio', { name: 'Invites' }).check({ force: true });
  const { link, expires } = await createInvite(VIEWER);
  expect(new URL(link).pathname).toBe('/invite');
  expect(expires).toMatch(/^Expires .+\d/);
  inviteLink = link;
  const invites = page.getByRole('table', { name: 'Open invites' });
  const row = invites.getByRole('row', { name: new RegExp(VIEWER) });
  await expect(row.getByText('New account')).toBeVisible();
  await expect(row.getByText('Viewer', { exact: true })).toBeVisible();
});

test('the invite is redeemed in a fresh browser with its own passkey', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const viewerPage = await context.newPage();
    await addAuthenticator(viewerPage);
    const url = new URL(inviteLink);
    await viewerPage.goto(`${BASE_URL}${url.pathname}${url.hash}`);
    await expect(
      viewerPage.getByRole('heading', { level: 1, name: 'Join Cinewren' }),
    ).toBeVisible();
    await expect(viewerPage.getByText(VIEWER, { exact: true })).toBeVisible();
    await viewerPage.getByRole('button', { name: 'Create passkey' }).click();
    await expect(viewerPage.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expect(viewerPage.getByRole('link', { name: `Account, ${VIEWER}` })).toBeVisible();
    // A viewer has no operator navigation.
    await expect(
      viewerPage.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Servers' }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the viewer appears as active, and the operator edits their access', async () => {
  await page.reload();
  await page.getByRole('radio', { name: 'People' }).check({ force: true });
  const row = peopleTable().getByRole('row', { name: new RegExp(VIEWER) });
  await expect(row.getByText('Active')).toBeVisible();
  await expect(row.getByText('2 of 2 libraries')).toBeVisible();

  await row.getByRole('button', { name: `Edit access for ${VIEWER}` }).click();
  const dialog = page.getByRole('dialog', { name: `Library access for ${VIEWER}` });
  await expect(dialog.getByRole('checkbox', { name: /Shows/ })).toBeChecked();
  await dialog.getByRole('checkbox', { name: /Shows/ }).uncheck();
  await dialog.getByRole('button', { name: 'Save access' }).click();
  await expect(page.getByText(`Saved library access for ${VIEWER}.`)).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(row.getByText('1 of 2 libraries')).toBeVisible();
});

test('disabling the viewer changes their status', async () => {
  const row = peopleTable().getByRole('row', { name: new RegExp(VIEWER) });
  await row.getByRole('button', { name: `Disable ${VIEWER}` }).click();
  await expect(page.getByText(`Disabled ${VIEWER}. Their sessions ended.`)).toBeVisible();
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible();
  await expect(row.getByRole('button', { name: `Enable ${VIEWER}` })).toBeVisible();
});

test('a second invite can be revoked and leaves the open invites', async () => {
  await page.getByRole('radio', { name: 'Invites' }).check({ force: true });
  await createInvite(REVOKED);
  const invites = page.getByRole('table', { name: 'Open invites' });
  await expect(invites.getByRole('row', { name: new RegExp(REVOKED) })).toBeVisible();
  await page.getByRole('button', { name: `Revoke the invite for ${REVOKED}` }).click();
  await expect(page.getByText(`Revoked the invite for ${REVOKED}.`)).toBeVisible();
  await expect(page.getByText(REVOKED, { exact: true })).toHaveCount(0);
});
