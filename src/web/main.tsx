import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, onApiError } from './lib/api';
import { initTheme } from './lib/theme';
import { ToastProvider } from './components/ui/overlay';
import { App } from './App';
import './index.css';

initTheme();

// The push service worker is registered when someone turns push on (lib/push.ts). When a
// notification is clicked while a tab it doesn't control is open, it asks that tab to go there.
navigator.serviceWorker?.addEventListener('message', (e: MessageEvent<{ type?: string; url?: string }>) => {
  if (e.data?.type === 'open' && e.data.url?.startsWith('/')) location.assign(e.data.url);
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
    },
  },
});

// A lost session or an unclaimed instance sends the app back to sign-in or setup.
onApiError((e) => {
  if ((e.status === 401 && e.code !== 'invalid_login' && e.code !== 'invalid_code') || e.code === 'setup_required' || e.code === 'password_change_required') {
    queryClient.invalidateQueries({ queryKey: ['session'] });
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
