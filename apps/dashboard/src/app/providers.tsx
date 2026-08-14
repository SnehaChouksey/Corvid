'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { Toaster } from 'sonner';

import { isApiError } from '@/lib/api/client';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            retry: (failureCount, error) => {
              // Never retry a domain outcome (401/403/404/429/409/400) — only transient
              // network/5xx failures are worth a retry (CODING_STANDARDS §4: a tooling error is
              // never read as a clean negative, and a typed refusal is never treated as flaky).
              if (isApiError(error) && error.status < 500) {
                return false;
              }
              return failureCount < 2;
            },
          },
          mutations: {
            retry: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster
        theme="dark"
        position="top-right"
        toastOptions={{
          classNames: {
            toast: 'bg-popover! border-border! text-popover-foreground!',
          },
        }}
      />
    </QueryClientProvider>
  );
}
