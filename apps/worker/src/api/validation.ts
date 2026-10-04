import type { Context } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from './context';
import { AppError } from './errors';

/**
 * Parses a JSON body against a shared zod schema. Only `application/json` bodies are accepted
 * (TDD §5.1), which also rules out cross-site form posts. Failures map to VALIDATION_FAILED with
 * `details.fields` (LLD-ERR).
 */
export async function parseJson<S extends z.ZodType>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.output<S>> {
  const type = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(type)) {
    throw new AppError('VALIDATION_FAILED', 'The request body must be JSON.');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new AppError('VALIDATION_FAILED', 'The request body must be JSON.');
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))];
    throw new AppError('VALIDATION_FAILED', 'The request was invalid.', { fields });
  }
  return result.data;
}
