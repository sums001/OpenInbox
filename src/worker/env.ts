// Bindings and variables. Secrets come from the Deploy button form (see .dev.vars.example);
// the *_API_BASE overrides exist only for local development and tests, which point every
// external API at a mock server.
export interface Env {
  DB: D1Database;
  ENCRYPTION_KEY?: string;
  // Set only while rotating the key: old credentials still decrypt until re-encrypted.
  ENCRYPTION_KEY_PREVIOUS?: string;
  CF_API_TOKEN?: string;
  CF_API_BASE?: string;
  RESEND_API_BASE?: string;
  BREVO_API_BASE?: string;
  MAILJET_API_BASE?: string;
  GITHUB_API_BASE?: string;
  WORKER_NAME?: string;
}

declare global {
  const __APP_VERSION__: string;
}
