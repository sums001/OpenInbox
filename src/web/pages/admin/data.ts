import { useQuery } from '@tanstack/react-query';
import { get } from '../../lib/api';
import type { Overview } from '../../lib/types';

// The overview page polls; the admin layout only reads it once (and whatever the page fetched since).
export function useOverview(poll = false) {
  return useQuery({ queryKey: ['admin', 'overview'], queryFn: () => get<Overview>('/admin/overview'), refetchInterval: poll ? 60_000 : false, staleTime: poll ? 0 : 5 * 60_000 });
}
