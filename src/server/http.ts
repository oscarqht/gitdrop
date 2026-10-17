import { ZodError } from 'zod';
import { HttpError, hosted, requireAccess } from './auth';
import { syncState } from './sync-worker';
import type { Snapshot } from '../storage/types';

export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
export function snapshot(data: Snapshot) {
  return json({
    ...data,
    mode: hosted() ? 'github' : 'local',
    ...(hosted() ? {} : syncState(data.revision)),
  });
}
export function handler(fn: (request: Request) => Promise<Response>, mutate = false, auth = true) {
  return async (request: Request) => {
    try {
      if (auth) requireAccess(request, mutate);
      return await fn(request);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      if (error instanceof ZodError)
        return json(
          { error: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
          400,
        );
      const message = error instanceof Error ? error.message : '';
      if (
        /not found|does not exist|already exists|cycle|invalid|diagnostic|repair|record ID|variant|collection|cannot|must |required/i.test(
          message,
        )
      )
        return json({ error: message }, 400);
      return json(
        {
          error:
            'The operation could not be completed. Check server configuration and connectivity, then retry.',
        },
        500,
      );
    }
  };
}
export async function readBody(request: Request, limit = 1_000_000): Promise<Uint8Array> {
  if (Number(request.headers.get('content-length') || 0) > limit)
    throw new HttpError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new HttpError(413, 'Request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
export async function readJson(request: Request, limit = 1_000_000) {
  try {
    return JSON.parse(Buffer.from(await readBody(request, limit)).toString('utf8'));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Invalid JSON request.');
  }
}
