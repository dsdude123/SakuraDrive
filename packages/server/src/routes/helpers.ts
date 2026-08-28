import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

export const SESSION_COOKIE = 'sd_session';

/** Parse a request payload, replying with 400 and the validation detail on failure. */
export function parseBody<T extends z.ZodTypeAny>(
  schema: T,
  request: FastifyRequest,
  reply: FastifyReply,
): z.infer<T> | null {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    reply.code(400).send({
      error: 'invalid_request',
      message: 'The request body is not valid',
      details: result.error.flatten(),
    });
    return null;
  }
  return result.data;
}

export function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  request: FastifyRequest,
  reply: FastifyReply,
): z.infer<T> | null {
  const result = schema.safeParse(request.query);
  if (!result.success) {
    reply.code(400).send({
      error: 'invalid_request',
      message: 'The query string is not valid',
      details: result.error.flatten(),
    });
    return null;
  }
  return result.data;
}

/** Coerce `?limit=100` style params, which arrive as strings. */
export const intParam = (fallback: number, max = 10_000) =>
  z.coerce.number().int().min(0).max(max).default(fallback);

export const boolParam = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((value) => value === true || value === 'true' || value === '1');

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Render rows as CSV, quoting properly so paths containing commas survive. */
export function toCsv(headers: readonly string[], rows: ReadonlyArray<ReadonlyArray<unknown>>): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) lines.push(row.map(escape).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export function sendCsv(reply: FastifyReply, fileName: string, csv: string): void {
  reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${fileName}"`)
    .send(csv);
}
