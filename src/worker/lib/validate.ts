import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest } from './errors';

// Parses and validates a JSON body; the first issue becomes a readable 400 message.
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Expected a JSON body.');
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue?.path.join('.');
    throw badRequest(field ? `${field}: ${issue.message}` : (issue?.message ?? 'Invalid request.'), 'validation', r.error.issues);
  }
  return r.data;
}

export function intParam(c: Context, name: string): number {
  const v = Number(c.req.param(name));
  if (!Number.isSafeInteger(v) || v <= 0) throw badRequest(`Invalid ${name}.`);
  return v;
}
