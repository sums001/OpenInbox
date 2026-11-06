import type { Env } from './env';
import type { AppSettings } from './db/settings';
import type { ApiScope, Role } from '../shared/constants';

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  totpEnabled: boolean;
  preferences: Record<string, unknown>;
}

export interface SessionInfo {
  id: string;
  mfaPending: boolean;
}

// The API key behind an /api/v1 request.
export interface ApiKeyInfo {
  id: number;
  scopes: ApiScope[];
  mailboxIds: number[] | null;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    settings: AppSettings;
    user: SessionUser | null;
    session: SessionInfo | null;
    apiKey: ApiKeyInfo | null;
  };
};
