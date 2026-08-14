import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { isCorvidError } from '@corvid/errors';

import {
  challengeInstructions,
  dnsChallengeName,
  hostForTarget,
  mintChallengeToken,
  type ProofPorts,
  readPendingToken,
  verifyProofOfControl,
  WELL_KNOWN_PATH,
} from '../src/index.ts';

const HOST = 'app.example.com';
const PUBLIC_IP = '93.184.216.34';

// A fake ProofPorts assembled per test — no network, no DNS. Each field defaults to "not found".
function ports(overrides: Partial<ProofPorts> = {}): ProofPorts {
  return {
    resolveTxt: async () => [],
    resolveHostIps: async () => [PUBLIC_IP],
    fetchText: async () => ({ ok: false, status: 404, body: '' }),
    ...overrides,
  };
}

test('mintChallengeToken returns unguessable, unique, url-safe tokens', () => {
  const a = mintChallengeToken();
  const b = mintChallengeToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 40);
  assert.match(a, /^[A-Za-z0-9_-]+$/); // base64url
});

test('hostForTarget extracts the hostname and fails closed on a bad URL', () => {
  assert.equal(hostForTarget('https://App.Example.com/path'), 'app.example.com');
  assert.throws(() => hostForTarget('not a url'), (e) => isCorvidError(e) && e.kind === 'authorization');
});

test('challengeInstructions describes both the DNS and well-known placements', () => {
  const token = 'tok-123';
  const inst = challengeInstructions(HOST, token);
  assert.equal(inst.dns.name, dnsChallengeName(HOST));
  assert.equal(inst.dns.value, token);
  assert.equal(inst.wellKnown.url, `https://${HOST}${WELL_KNOWN_PATH}`);
  assert.equal(inst.wellKnown.expectedContent, token);
});

test('readPendingToken accepts a valid pending proof, rejects everything else', () => {
  assert.equal(readPendingToken({ status: 'pending', token: 'abc', issuedAt: 'x' }), 'abc');
  assert.equal(readPendingToken(null), null);
  assert.equal(readPendingToken({ status: 'verified', token: 'abc' }), null);
  assert.equal(readPendingToken({ status: 'pending' }), null); // malformed → mint fresh, no crash
});

test('DNS proof verifies when a matching TXT record exists (chunks joined)', async () => {
  const token = mintChallengeToken();
  const result = await verifyProofOfControl(
    HOST,
    token,
    ports({ resolveTxt: async (name) => (name === dnsChallengeName(HOST) ? [[token.slice(0, 5), token.slice(5)]] : []) }),
  );
  assert.deepEqual(result, { verified: true, method: 'dns', evidence: dnsChallengeName(HOST) });
});

test('DNS-only method does not fall through to the well-known fetch', async () => {
  const token = mintChallengeToken();
  let fetched = false;
  const result = await verifyProofOfControl(
    HOST,
    token,
    ports({
      resolveTxt: async () => [['some-other-value']],
      fetchText: async () => {
        fetched = true;
        return { ok: true, status: 200, body: token };
      },
    }),
    { method: 'dns' },
  );
  assert.equal(result.verified, false);
  assert.equal(fetched, false); // stayed within the requested method
});

test('well-known proof verifies when the file contains the token on its own line', async () => {
  const token = mintChallengeToken();
  const result = await verifyProofOfControl(
    HOST,
    token,
    ports({ fetchText: async () => ({ ok: true, status: 200, body: `# corvid\n${token}\n` }) }),
    { method: 'well_known' },
  );
  assert.deepEqual(result, {
    verified: true,
    method: 'well_known',
    evidence: `https://${HOST}${WELL_KNOWN_PATH}`,
  });
});

test('a sent-but-wrong well-known body is not proven (fail closed)', async () => {
  const result = await verifyProofOfControl(
    HOST,
    mintChallengeToken(),
    ports({ fetchText: async () => ({ ok: true, status: 200, body: 'unrelated' }) }),
    { method: 'well_known' },
  );
  assert.equal(result.verified, false);
});

test('a literal dangerous host is refused before any lookup (SSRF guard)', async () => {
  await assert.rejects(
    () => verifyProofOfControl('169.254.169.254', 'tok', ports()),
    (e) => isCorvidError(e) && e.kind === 'authorization',
  );
});

test('a host that RESOLVES to a dangerous IP is refused on the well-known fetch (SSRF guard)', async () => {
  await assert.rejects(
    () =>
      verifyProofOfControl(
        HOST,
        'tok',
        ports({ resolveHostIps: async () => ['169.254.169.254'], fetchText: async () => ({ ok: true, status: 200, body: 'tok' }) }),
        { method: 'well_known' },
      ),
    (e) => isCorvidError(e) && e.kind === 'authorization',
  );
});

test('a DNS/fetch failure is "not proven", never an exception', async () => {
  const result = await verifyProofOfControl(
    HOST,
    'tok',
    ports({
      resolveTxt: async () => {
        throw new Error('NXDOMAIN');
      },
      resolveHostIps: async () => {
        throw new Error('ENOTFOUND');
      },
    }),
  );
  assert.equal(result.verified, false);
});
