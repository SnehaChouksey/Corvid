'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { CorvidMark } from '@/components/corvid-mark';
import { useSession } from '@/lib/auth-client';

/**
 * The one gate every protected screen sits behind: no anonymous surface besides sign-in/sign-up
 * (`01` §1). Session state is the single source of truth — an expired/missing session redirects
 * client-side rather than each screen re-deriving "am I logged in" from a query error.
 */
export function RequireAuth({ children }: { readonly children: React.ReactNode }) {
  const { data, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!isPending && data === null) {
      router.replace('/sign-in');
    }
  }, [isPending, data, router]);

  if (isPending || data === null) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <CorvidMark className="text-primary size-8 animate-pulse motion-reduce:animate-none" />
      </div>
    );
  }

  return <>{children}</>;
}
