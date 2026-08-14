'use client';

import { TbLock } from 'react-icons/tb';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export interface CredentialsFormState {
  useCrawlLogin: boolean;
  loginUrl: string;
  username: string;
  password: string;
  useJwt: boolean;
  jwtSample: string;
  useIdor: boolean;
  primaryLabel: string;
  primaryHeaders: string;
  secondaryLabel: string;
  secondaryHeaders: string;
}

export const initialCredentialsFormState: CredentialsFormState = {
  useCrawlLogin: false,
  loginUrl: '',
  username: '',
  password: '',
  useJwt: false,
  jwtSample: '',
  useIdor: false,
  primaryLabel: 'admin',
  primaryHeaders: '',
  secondaryLabel: 'user',
  secondaryHeaders: '',
};

interface CredentialsFieldsProps {
  readonly state: CredentialsFormState;
  readonly onChange: (next: CredentialsFormState) => void;
}

export function CredentialsFields({ state, onChange }: CredentialsFieldsProps) {
  function set<K extends keyof CredentialsFormState>(key: K, value: CredentialsFormState[K]) {
    onChange({ ...state, [key]: value });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <TbLock className="size-3.5" />
        Optional — a scan with no credentials tests the unauthenticated surface only. Secrets are
        encrypted at rest and are never shown again after you submit this form.
      </div>

      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <Checkbox
            id="use-crawl-login"
            checked={state.useCrawlLogin}
            onCheckedChange={(checked) => set('useCrawlLogin', checked === true)}
          />
          <Label htmlFor="use-crawl-login" className="text-sm font-medium">
            Crawl login — map the authenticated surface
          </Label>
        </CardHeader>
        {state.useCrawlLogin ? (
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="loginUrl">Login URL</Label>
              <Input
                id="loginUrl"
                type="url"
                placeholder="https://app.example.com/login"
                value={state.loginUrl}
                onChange={(event) => set('loginUrl', event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="username">Username</Label>
                <Input id="username" value={state.username} onChange={(event) => set('username', event.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={state.password}
                  onChange={(event) => set('password', event.target.value)}
                />
              </div>
            </div>
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <Checkbox id="use-jwt" checked={state.useJwt} onCheckedChange={(checked) => set('useJwt', checked === true)} />
          <Label htmlFor="use-jwt" className="text-sm font-medium">
            Sample JWT — for alg:none / key-confusion / key-reuse forgeries
          </Label>
        </CardHeader>
        {state.useJwt ? (
          <CardContent>
            <Textarea
              id="jwtSample"
              placeholder="eyJhbGciOi..."
              value={state.jwtSample}
              onChange={(event) => set('jwtSample', event.target.value)}
            />
          </CardContent>
        ) : null}
      </Card>

      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <Checkbox id="use-idor" checked={state.useIdor} onCheckedChange={(checked) => set('useIdor', checked === true)} />
          <Label htmlFor="use-idor" className="text-sm font-medium">
            Two IDOR sessions — different privilege levels, for cross-account comparison
          </Label>
        </CardHeader>
        {state.useIdor ? (
          <CardContent className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="primaryLabel">Primary label</Label>
              <Input id="primaryLabel" value={state.primaryLabel} onChange={(event) => set('primaryLabel', event.target.value)} />
              <Label htmlFor="primaryHeaders" className="mt-2">
                Headers
              </Label>
              <Textarea
                id="primaryHeaders"
                placeholder={'Cookie: session=...\nAuthorization: Bearer ...'}
                value={state.primaryHeaders}
                onChange={(event) => set('primaryHeaders', event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="secondaryLabel">Secondary label</Label>
              <Input
                id="secondaryLabel"
                value={state.secondaryLabel}
                onChange={(event) => set('secondaryLabel', event.target.value)}
              />
              <Label htmlFor="secondaryHeaders" className="mt-2">
                Headers
              </Label>
              <Textarea
                id="secondaryHeaders"
                placeholder={'Cookie: session=...\nAuthorization: Bearer ...'}
                value={state.secondaryHeaders}
                onChange={(event) => set('secondaryHeaders', event.target.value)}
              />
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}
