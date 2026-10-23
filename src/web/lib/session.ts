import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get } from './api';
import type { Session } from './types';

export function useSession() {
  return useQuery({ queryKey: ['session'], queryFn: () => get<Session>('/auth/session'), staleTime: 5 * 60_000 });
}

export function useUser() {
  const { data } = useSession();
  return data?.user ?? null;
}

export function useIsAdmin(): boolean {
  const user = useUser();
  return user?.role === 'owner' || user?.role === 'admin';
}

export function useRefreshSession() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['session'] });
}
