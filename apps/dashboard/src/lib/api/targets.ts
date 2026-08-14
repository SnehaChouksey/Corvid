import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiFetch } from './client';
import {
  type AuthorizeResponse,
  authorizeResponseSchema,
  createdIdSchema,
  type ScopeRules,
  targetSummarySchema,
  targetsListSchema,
} from './schemas';

export const targetsKeys = {
  all: ['targets'] as const,
  detail: (id: string) => ['targets', id] as const,
};

export function useTargets() {
  return useQuery({
    queryKey: targetsKeys.all,
    queryFn: () => apiFetch('/api/targets', targetsListSchema).then((r) => r.targets),
  });
}

export function useTarget(id: string) {
  return useQuery({
    queryKey: targetsKeys.detail(id),
    queryFn: () => apiFetch(`/api/targets/${id}`, targetSummarySchema),
    enabled: id.length > 0,
  });
}

export interface CreateTargetInput {
  readonly url: string;
  readonly scopeRules: ScopeRules;
}

export function useCreateTarget() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTargetInput) =>
      apiFetch('/api/targets', createdIdSchema, { method: 'POST', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: targetsKeys.all });
    },
  });
}

export interface UpdateTargetInput {
  readonly url?: string;
  readonly scopeRules?: ScopeRules;
}

export function useUpdateTarget(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateTargetInput) =>
      apiFetch(`/api/targets/${id}`, targetSummarySchema, { method: 'PATCH', body: input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: targetsKeys.all });
      void queryClient.invalidateQueries({ queryKey: targetsKeys.detail(id) });
    },
  });
}

export function useAuthorizeTarget(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (method?: 'dns' | 'well_known'): Promise<AuthorizeResponse> =>
      apiFetch(`/api/targets/${id}/authorize`, authorizeResponseSchema, {
        method: 'POST',
        body: method !== undefined ? { method } : {},
      }),
    onSuccess: (result) => {
      if (result.status === 'authorized') {
        void queryClient.invalidateQueries({ queryKey: targetsKeys.all });
        void queryClient.invalidateQueries({ queryKey: targetsKeys.detail(id) });
      }
    },
  });
}

