import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Test-only master keys (DR-002): two versions so rotation can be exercised. Never real secrets.
const testKey = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));

// Migrations are read in Node and applied to the local D1 inside the Workers runtime by
// test/apply-migrations.ts (T0.4, TDD §7), the same files `wrangler d1 migrations apply` uses.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(`${import.meta.dirname}/migrations`);
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            CREDENTIAL_KEYS: JSON.stringify({ '1': testKey(1), '2': testKey(2) }),
            CREDENTIAL_KEY_CURRENT: '1',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/apply-migrations.ts'] },
  };
});
