import { beforeEach, expect, it } from 'vitest';
import { call, login, resetDb, setupOperator } from './auth-harness';
beforeEach(resetDb);
it('setup + login', async () => {
  const { auth, cookie } = await setupOperator();
  expect((await call('GET', '/api/v1/me', { cookie })).status).toBe(200);
  const res = await login(auth);
  console.error(await res.clone().text());
  expect(res.status).toBe(200);
});
