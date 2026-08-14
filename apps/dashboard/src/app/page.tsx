'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { CorvidMark } from '@/components/corvid-mark';
import { useSession } from '@/lib/auth-client';

export default function IndexPage() {
  const { data, isPending } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (isPending) {
      return;
    }
    router.replace(data === null ? '/sign-in' : '/targets');
  }, [isPending, data, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <CorvidMark className="text-primary size-8 animate-pulse motion-reduce:animate-none" />
    </div>
  );
}
