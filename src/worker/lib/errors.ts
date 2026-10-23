// An error with an HTTP status and a stable code the web app can switch on.
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Please sign in.', code = 'unauthorized') => new HttpError(401, code, message);
export const forbidden = (message = 'You do not have access to this.', code = 'forbidden') =>
  new HttpError(403, code, message);
export const notFound = (message = 'Not found.', code = 'not_found') => new HttpError(404, code, message);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const tooMany = (message: string, retryAfter: number) =>
  new HttpError(429, 'rate_limited', message, { retryAfter });

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
