// Structured logs for Workers Observability. Never log secrets or message bodies.
// Observability redacts a field named `auth`, so authentication results go under `authres`.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event, error: message, ...fields }));
}
