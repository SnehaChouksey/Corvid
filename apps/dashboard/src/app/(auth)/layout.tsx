import { CorvidMark } from '@/components/corvid-mark';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <div className="mb-10 flex flex-col items-center gap-4 text-center">
        <CorvidMark className="text-primary size-9" />
        <div>
          <h1 className="font-display text-3xl tracking-tight">Corvid</h1>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Authorize a target. Approve every payload. Verify before you report.
          </p>
        </div>
      </div>
      {children}
    </div>
  );
}
