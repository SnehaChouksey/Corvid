import { readFileSync } from 'node:fs';

import { burstInputSchema } from '@corvid/tool-contracts';

import { BURST_OUTPUT_BEGIN as BEGIN, BURST_OUTPUT_END as END } from './markers.ts';
import { runBurst } from './run.ts';

// The in-sandbox entry (bundled to dist/bundle.cjs and shipped into E2B). Reads the BurstInput JSON
// the gateway wrote in, runs the burst, and prints the BurstOutput between markers on stdout so the
// gateway can extract it even if a dependency writes stray output. stderr carries diagnostics only.

async function main(): Promise<void> {
  const inputPath = process.argv[2] ?? '/home/user/burst-input.json';
  const input = burstInputSchema.parse(JSON.parse(readFileSync(inputPath, 'utf8')));
  const output = await runBurst(input);
  process.stdout.write(`${BEGIN}${JSON.stringify(output)}${END}`);
}

main().catch((err: unknown) => {
  // Safe fields only (§5): never print the raw error message, which could carry a URL/secret.
  process.stderr.write(`burst-runner failed: ${err instanceof Error ? err.name : 'unknown'}\n`);
  process.exit(1);
});
