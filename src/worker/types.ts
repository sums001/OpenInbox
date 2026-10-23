import type { Env } from './env';
import type { AppSettings } from './db/settings';
import type { Role } from '../shared/constants';

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

export type AppBindings = {
  Bindings: Env;
  Variables: {
    settings: AppSettings;
    user: SessionUser | null;
    session: SessionInfo | null;
  };
};
