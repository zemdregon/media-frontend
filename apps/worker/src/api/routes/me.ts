import { Hono } from 'hono';
import {
  passkeyOptionsRequest,
  passkeyVerifyRequest,
  reauthVerifyRequest,
  updatePreferencesRequest,
  type Me,
} from '@cinewren/shared';
import {
  addPasskeyOptions,
  addPasskeyVerify,
  ownPasskeys,
  reauthOptions,
  reauthVerify,
  removePasskey,
} from '../../auth/passkeys';
import { currentUser } from '../../auth/sessions';
import { setTheme } from '../../users/service';
import type { AppEnv } from '../context';
import { parseJson } from '../validation';

/** The signed-in user's own account (FR-USR-003, FR-USR-006). */
export const me = new Hono<AppEnv>()
  .get('/', (c) => {
    const u = currentUser(c);
    return c.json<Me>({
      id: u.userId,
      displayName: u.displayName,
      role: u.role,
      preferences: { theme: u.theme },
    });
  })
  .patch('/preferences', async (c) => {
    const { theme } = await parseJson(c, updatePreferencesRequest);
    return c.json(await setTheme(c, theme));
  })
  .post('/reauth/options', async (c) => c.json(await reauthOptions(c)))
  .post('/reauth/verify', async (c) =>
    c.json(await reauthVerify(c, await parseJson(c, reauthVerifyRequest))),
  )
  .get('/passkeys', async (c) => c.json(await ownPasskeys(c)))
  .post('/passkeys/options', async (c) => {
    // `label` is accepted here for LLD-API compatibility; it is stored from the verify body.
    if (c.req.header('content-type')) await parseJson(c, passkeyOptionsRequest);
    return c.json(await addPasskeyOptions(c));
  })
  .post('/passkeys/verify', async (c) =>
    c.json({ passkey: await addPasskeyVerify(c, await parseJson(c, passkeyVerifyRequest)) }, 201),
  )
  .delete('/passkeys/:id', async (c) => {
    await removePasskey(c, c.req.param('id'));
    return c.body(null, 204);
  });
