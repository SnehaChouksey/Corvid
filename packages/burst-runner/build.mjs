import { build } from 'esbuild';

// Bundle the in-sandbox entry into a single self-contained CJS file shipped into the E2B sandbox
// (which has Node 20 and no access to this repo's node_modules). platform:node keeps Node built-ins
// external; everything else (http-send, testers, scope, tool-contracts, zod) is inlined. Tree-shaking
// drops @corvid/http-send's DB-backed adapter (unused here) so `pg`/drizzle never enter the bundle —
// verified by the package's build check below.
const result = await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/bundle.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  logLevel: 'info',
  metafile: true,
});

// Fail the build if a server-only dependency leaked into the sandbox bundle — it would be dead weight
// at best and a footgun at worst (the sandbox has no DB/Redis reachability by design).
const inputs = Object.keys(result.metafile.inputs).join('\n');
const forbidden = ['/pg/', 'drizzle-orm', 'ioredis', 'playwright', '@e2b', '/e2b/'];
const leaked = forbidden.filter((f) => inputs.includes(f));
if (leaked.length > 0) {
  console.error(`burst bundle leaked server-only deps: ${leaked.join(', ')}`);
  process.exit(1);
}
