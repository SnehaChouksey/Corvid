'use client';

import { FcGoogle } from 'react-icons/fc';
import { TbLoader2 } from 'react-icons/tb';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Separator } from '@/components/ui/separator';
import { signIn } from '@/lib/auth-client';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = submitting || googleSubmitting;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: signInError } = await signIn.email({ email, password });
    setSubmitting(false);
    if (signInError) {
      setError(signInError.message ?? 'Invalid email or password.');
      return;
    }
    router.replace('/targets');
  }

  async function handleGoogleSignIn() {
    setGoogleSubmitting(true);
    setError(null);
    const { error: signInError } = await signIn.social({ provider: 'google', callbackURL: '/targets' });
    setGoogleSubmitting(false);
    if (signInError) {
      setError(signInError.message ?? 'Could not continue with Google.');
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-lg">Sign in</CardTitle>
        <CardDescription>Use the credentials for your Corvid analyst account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
          {error !== null ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="password">Password</Label>
            <PasswordInput
              id="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy} className="mt-1">
            {submitting ? <TbLoader2 className="animate-spin" /> : null}
            Sign in
          </Button>
        </form>
        <div className="my-5 flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-xs tracking-wide text-muted-foreground uppercase">or continue with</span>
          <Separator className="flex-1" />
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={busy}
          onClick={() => void handleGoogleSignIn()}
        >
          {googleSubmitting ? <TbLoader2 className="animate-spin" /> : <FcGoogle className="size-4" />}
          Continue with Google
        </Button>
        <p className="mt-5 text-center text-sm text-muted-foreground">
          No account?{' '}
          <Link href="/sign-up" className="text-primary hover:underline">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
