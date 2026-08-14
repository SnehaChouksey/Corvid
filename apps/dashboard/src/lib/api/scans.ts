import type { ScanCredentials } from '@corvid/tool-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from './client';
import {
  approvalAcceptedSchema,
  auditListSchema,
  cancelAcceptedSchema,
  createdIdSchema,
  findingsListSchema,
  hypothesesListSchema,
  type ScanSummary,
  scanSummarySchema,
  scansListSchema,
} from './schemas';

export const scansKeys = {
  all: ['scans'] as const,
  detail: (id: string) => ['scans', id] as const,
  hypotheses: (id: string) => ['scans', id, 'hypotheses'] as const,
  findings: (id: string) => ['scans', id, 'findings'] as const,
  audit: (id: string) => ['scans', id, 'audit'] as const,
};

/** Terminal scan states never change again — stop polling once here (`02` §5.1). */
const TERMINAL_STATUSES = new Set<ScanSummary['status']>(['completed', 'rejected', 'cancelled', 'stopped']);

/** Poll a live scan every 3s while it's still in flight; stop entirely once terminal. */
function livePollInterval(status: ScanSummary['status'] | undefined): number | false {
  if (status === undefined || TERMINAL_STATUSES.has(status)) {
    return false;
  }
  return 3_000;
}

export function useScans() {
  return useQuery({
    queryKey: scansKeys.all,
    queryFn: () => apiFetch('/api/scans', scansListSchema).then((r) => r.scans),
  });
}

export function useScan(id: string) {
  return useQuery({
    queryKey: scansKeys.detail(id),
    queryFn: () => apiFetch(`/api/scans/${id}`, scanSummarySchema),
    enabled: id.length > 0,
    refetchInterval: (query) => livePollInterval(query.state.data?.status),
  });
}

export function useHypotheses(scanId: string, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: scansKeys.hypotheses(scanId),
    queryFn: () => apiFetch(`/api/scans/${scanId}/hypotheses`, hypothesesListSchema).then((r) => r.hypotheses),
    enabled: scanId.length > 0,
    refetchInterval: options.poll === true ? 3_000 : false,
  });
}

export function useFindings(scanId: string, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: scansKeys.findings(scanId),
    queryFn: () => apiFetch(`/api/scans/${scanId}/findings`, findingsListSchema).then((r) => r.findings),
    enabled: scanId.length > 0,
    refetchInterval: options.poll === true ? 5_000 : false,
  });
}

export function useAudit(scanId: string, options: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: scansKeys.audit(scanId),
    queryFn: () => apiFetch(`/api/scans/${scanId}/audit`, auditListSchema).then((r) => r.audit),
    enabled: scanId.length > 0,
    refetchInterval: options.poll === true ? 5_000 : false,
  });
}

export interface CreateScanInput {
  readonly targetId: string;
  readonly credentials?: ScanCredentials;
}

export function useCreateScan() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScanInput) => apiFetch('/api/scans', createdIdSchema, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scansKeys.all });
    },
  });
}

export function useSubmitApproval(scanId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (approvedHypotheses: readonly string[]) =>
      apiFetch(`/api/scans/${scanId}/approvals`, approvalAcceptedSchema, {
        method: 'POST',
        body: { approvedHypotheses },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scansKeys.detail(scanId) });
      void queryClient.invalidateQueries({ queryKey: scansKeys.hypotheses(scanId) });
      void queryClient.invalidateQueries({ queryKey: scansKeys.audit(scanId) });
    },
  });
}

export function useCancelScan(scanId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch(`/api/scans/${scanId}/cancel`, cancelAcceptedSchema, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: scansKeys.detail(scanId) });
      void queryClient.invalidateQueries({ queryKey: scansKeys.audit(scanId) });
    },
  });
}
