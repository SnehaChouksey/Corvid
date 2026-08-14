'use client';

import { TbAlertTriangle, TbLoader2 } from 'react-icons/tb';
import { useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { fieldsToScopeRules, scopeRulesToFields } from '@/lib/scope';

import type { ScopeRules } from '@/lib/api/schemas';

export interface TargetScopeFormValues {
  readonly url: string;
  readonly scopeRules: ScopeRules;
}

interface TargetScopeFormProps {
  readonly mode: 'create' | 'edit';
  readonly initialUrl?: string;
  readonly initialScopeRules?: ScopeRules;
  /** Edit-mode only: the target is currently authorized, so ANY save invalidates it. */
  readonly currentlyAuthorized?: boolean;
  readonly submitting: boolean;
  readonly errorMessage?: string | null;
  readonly onSubmit: (values: TargetScopeFormValues) => void;
}

export function TargetScopeForm({
  mode,
  initialUrl = '',
  initialScopeRules,
  currentlyAuthorized = false,
  submitting,
  errorMessage = null,
  onSubmit,
}: TargetScopeFormProps) {
  const initialFields = scopeRulesToFields(initialScopeRules);
  const [url, setUrl] = useState(initialUrl);
  const [hosts, setHosts] = useState(initialFields.hosts);
  const [includePaths, setIncludePaths] = useState(initialFields.includePaths);
  const [excludePaths, setExcludePaths] = useState(initialFields.excludePaths);
  const [confirmOpen, setConfirmOpen] = useState(false);

  function buildValues(): TargetScopeFormValues {
    return { url, scopeRules: fieldsToScopeRules({ hosts, includePaths, excludePaths }) };
  }

  function handleFormSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === 'edit' && currentlyAuthorized) {
      setConfirmOpen(true);
      return;
    }
    onSubmit(buildValues());
  }

  return (
    <>
      <form className="flex flex-col gap-5" onSubmit={handleFormSubmit}>
        {errorMessage !== null ? (
          <Alert variant="destructive">
            <TbAlertTriangle />
            <AlertTitle>Scope rejected</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {mode === 'edit' && currentlyAuthorized ? (
          <Alert variant="warning">
            <TbAlertTriangle />
            <AlertTitle>This will invalidate authorization</AlertTitle>
            <AlertDescription>
              This target is currently authorized. Saving any change here immediately returns it to
              Unauthorized — you&apos;ll need to re-prove control before Corvid can scan it again.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="url">Base URL</Label>
          <Input
            id="url"
            type="url"
            required
            placeholder="https://app.example.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hosts">Scope hosts</Label>
          <Textarea
            id="hosts"
            required
            placeholder={'app.example.com\napi.example.com'}
            value={hosts}
            onChange={(event) => setHosts(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">One host per line. At least one is required.</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="includePaths">Include paths (optional)</Label>
            <Textarea
              id="includePaths"
              placeholder={'/app\n/api'}
              value={includePaths}
              onChange={(event) => setIncludePaths(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="excludePaths">Exclude paths (optional)</Label>
            <Textarea
              id="excludePaths"
              placeholder={'/admin/danger-zone'}
              value={excludePaths}
              onChange={(event) => setExcludePaths(event.target.value)}
            />
          </div>
        </div>

        <Button type="submit" disabled={submitting} className="self-start">
          {submitting ? <TbLoader2 className="animate-spin" /> : null}
          {mode === 'create' ? 'Add target' : 'Save changes'}
        </Button>
      </form>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save and invalidate authorization?</DialogTitle>
            <DialogDescription>
              This target is authorized right now. Saving this change returns it to{' '}
              <span className="font-medium text-foreground">Unauthorized</span> immediately — no scan can
              start against it until you re-prove control.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onSubmit(buildValues());
              }}
            >
              Save and invalidate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
