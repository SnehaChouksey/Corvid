'use client';

import { TbCrosshair, TbLogout, TbRadar } from 'react-icons/tb';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

import { CorvidMark } from '@/components/corvid-mark';
import { Button } from '@/components/ui/button';
import { signOut, useSession } from '@/lib/auth-client';

const NAV_ITEMS = [
  { href: '/targets', label: 'Targets', icon: TbCrosshair },
  { href: '/scans', label: 'Scans', icon: TbRadar },
] as const;

export function AppShell({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data } = useSession();

  return (
    <div className="grid min-h-screen grid-cols-[15rem_1fr]">
      <aside className="flex flex-col border-r border-border bg-card/40 px-4 py-5">
        <Link href="/targets" className="mb-8 flex items-center gap-2 px-2">
          <CorvidMark className="text-primary size-6" />
          <span className="font-display text-xl tracking-tight">Corvid</span>
        </Link>

        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-3 border-t border-border pt-4">
          <div className="px-2">
            <p className="truncate text-sm font-medium">{data?.user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{data?.user.email}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="justify-start text-muted-foreground"
            onClick={() => {
              void signOut().then(() => router.replace('/sign-in'));
            }}
          >
            <TbLogout />
            Sign out
          </Button>
        </div>
      </aside>

      <main className="min-w-0 px-8 py-8">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>
    </div>
  );
}
