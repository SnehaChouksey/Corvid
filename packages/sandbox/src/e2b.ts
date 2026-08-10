import { Sandbox } from 'e2b';

import type { RunningSandbox, SandboxCreateOptions, SandboxFactory } from './sandbox.ts';

// The real E2B-backed factory (ADR-22). `network.denyOut` is CIDR-only (0.0.0.0/0 = all), and
// `allowOut` carries the scope-derived hosts. The egress allow-list is set at create time, never
// hand-assembled per call. Requires E2B_API_KEY (Unit 0 provisioning).

export function createE2bSandboxFactory(apiKey: string): SandboxFactory {
  return {
    async create(options: SandboxCreateOptions): Promise<RunningSandbox> {
      const sandbox = await Sandbox.create({
        apiKey,
        timeoutMs: options.timeoutMs,
        network: {
          denyOut: [...options.network.denyOut],
          allowOut: [...options.network.allowOut],
        },
      });
      return {
        sandboxId: sandbox.sandboxId,
        kill: async () => {
          await sandbox.kill();
        },
      };
    },
  };
}
