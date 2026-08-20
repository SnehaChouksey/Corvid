import { CommandExitError, Sandbox } from 'e2b';

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
        writeFile: async (path, content) => {
          await sandbox.files.write(path, content);
        },
        run: async (cmd, runOptions) => {
          const opts = {
            ...(runOptions?.envs !== undefined ? { envs: runOptions.envs } : {}),
            ...(runOptions?.timeoutMs !== undefined ? { timeoutMs: runOptions.timeoutMs } : {}),
          };
          try {
            const res = await sandbox.commands.run(cmd, opts);
            return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
          } catch (err) {
            // A non-zero exit throws CommandExitError (which carries the captured output). Map it to a
            // result so a crashed burst is a typed outcome the caller inspects, not a raw throw (§4).
            if (err instanceof CommandExitError) {
              return {
                exitCode: err.exitCode,
                stdout: err.stdout,
                stderr: err.stderr,
                ...(err.error !== undefined ? { error: err.error } : {}),
              };
            }
            throw err;
          }
        },
        kill: async () => {
          await sandbox.kill();
        },
      };
    },
  };
}
