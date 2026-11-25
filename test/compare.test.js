import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareBlock, compareRange, describe, fetchFromAll, getFinality, kindOf, providerWarnings } from '../src/compare.js';
import { verifyHeaderHash } from '../src/header.js';

// Five consecutive mainnet blocks (22431084..22431088), headers only.
const sequence = JSON.parse(
  readFileSync(new URL('./fixtures/mainnet-sequence.json', import.meta.url), 'utf8'),
);
const first = BigInt(sequence[0].number);
const last = BigInt(sequence.at(-1).number);

/** A fake provider serving the fixture sequence, with optional per-block overrides. */
function mockClient(label, { edit = {}, fail = new Set() } = {}) {
  const byNumber = new Map(sequence.map((b) => [BigInt(b.number), b]));
  return {
    label,
    getBlock: async (n) => {
      if (fail.has(n)) throw new Error(`${label}: eth_getBlockByNumber request failed (ECONNRESET)`);
      if (n in edit) return edit[n];
      return byNumber.get(n) ?? null;
    },
  };
}

function forged(block, changes) {
  const copy = { ...block, ...changes };
  copy.hash = verifyHeaderHash(copy).expected; // self-consistent forgery
  return copy;
}

test('honest providers agree on every block', async () => {
  const clients = [mockClient('a'), mockClient('b'), mockClient('c')];
  const { checked, disagreements } = await compareRange({ clients, from: first, to: last });
  assert.equal(checked, 5);
  assert.deepEqual(disagreements, []);
});

test('a provider serving a different (self-consistent) block is a disagreement', async () => {
  // Header checks alone can't catch this one; only comparing providers can.
  const target = first + 2n;
  const fake = forged(sequence[2], { miner: '0x000000000000000000000000000000000000dead' });
  const clients = [mockClient('a'), mockClient('liar', { edit: { [target]: fake } }), mockClient('c')];

  const { disagreements } = await compareRange({ clients, from: first, to: last });
  assert.deepEqual(disagreements.map((d) => d.number), [target]);
  const liar = disagreements[0].responses.find((r) => r.label === 'liar');
  assert.equal(liar.hash, fake.hash);
  assert.equal(liar.valid, true);
});

test('a block whose fields do not match its hash is a disagreement even if the hash matches', async () => {
  const target = first + 1n;
  const tampered = { ...sequence[1], gasUsed: '0x1' }; // hash left as the real one
  const clients = [mockClient('a'), mockClient('b', { edit: { [target]: tampered } })];

  const { disagreements } = await compareRange({ clients, from: first, to: last });
  assert.equal(disagreements.length, 1);
  const b = disagreements[0].responses.find((r) => r.label === 'b');
  assert.equal(b.hash, sequence[1].hash.toLowerCase());
  assert.equal(b.valid, false);
});

test('a missing block or failed request is a disagreement but does not stop the run', async () => {
  const clients = [
    mockClient('a'),
    mockClient('lagging', { edit: { [last]: null } }),
    mockClient('flaky', { fail: new Set([first]) }),
  ];
  const { checked, disagreements } = await compareRange({ clients, from: first, to: last });
  assert.equal(checked, 5);
  assert.deepEqual(disagreements.map((d) => d.number), [first, last]);
  assert.match(disagreements[0].responses.find((r) => r.label === 'flaky').error, /ECONNRESET/);
  assert.equal(disagreements[1].responses.find((r) => r.label === 'lagging').missing, true);
});

test('fetchFromAll keeps provider order', async () => {
  const responses = await fetchFromAll([mockClient('x'), mockClient('y')], first);
  assert.deepEqual(responses.map((r) => r.label), ['x', 'y']);
});

test('a single provider trivially agrees with itself', () => {
  assert.equal(compareBlock(first, [{ label: 'only', block: sequence[0] }]).agreed, true);
});

// --- reporting --------------------------------------------------------------

const hashOf = (b) => b.hash.toLowerCase();

test('different hashes are a conflict, listed with who reported each', () => {
  const fake = forged(sequence[0], { miner: '0x000000000000000000000000000000000000dead' });
  const result = compareBlock(first, [
    { label: 'a', block: sequence[0] },
    { label: 'b', block: sequence[0] },
    { label: 'liar', block: fake },
  ]);
  assert.equal(kindOf(result), 'conflict');
  assert.deepEqual(describe(result), [
    `Block ${first}: providers DISAGREE`,
    `  ${hashOf(sequence[0])}  a, b`,
    `  ${fake.hash}  liar`,
  ]);
});

test('edited fields under the real hash are listed apart from honest providers', () => {
  const tampered = { ...sequence[0], gasUsed: '0x1' };
  const result = compareBlock(first, [
    { label: 'a', block: sequence[0] },
    { label: 'b', block: tampered },
  ]);
  assert.equal(kindOf(result), 'conflict');
  assert.deepEqual(describe(result), [
    `Block ${first}: providers DISAGREE`,
    `  ${hashOf(sequence[0])}  a`,
    `  ${hashOf(sequence[0])}  b  (block fields do NOT hash to this)`,
  ]);
});

test('missing blocks and errors alone are incomplete, not a conflict', () => {
  const result = compareBlock(first, [
    { label: 'a', block: sequence[0] },
    { label: 'b', block: null },
    { label: 'c', error: 'c: eth_getBlockByNumber returned HTTP 525' },
  ]);
  assert.equal(kindOf(result), 'incomplete');
  assert.deepEqual(describe(result), [
    `Block ${first}: not every provider returned this block`,
    `  ${hashOf(sequence[0])}  a`,
    '  no such block  b',
    '  request failed  c: eth_getBlockByNumber returned HTTP 525',
  ]);
});

test('agreement is its own kind', () => {
  const result = compareBlock(first, [{ label: 'a', block: sequence[0] }, { label: 'b', block: sequence[0] }]);
  assert.equal(kindOf(result), 'agree');
});

// --- finality ---------------------------------------------------------------

function finalityClient(finalized) {
  return {
    label: 'f',
    request: async (method, params) => {
      assert.deepEqual([method, params], ['eth_getBlockByNumber', ['finalized', false]]);
      if (finalized instanceof Error) throw finalized;
      return finalized === null ? null : { number: `0x${finalized.toString(16)}` };
    },
  };
}

test('a block is finalized if any provider says so: the boundary is the highest claim', async () => {
  const { boundary, providers } = await getFinality([
    { client: finalityClient(1000n), head: 1070n },
    { client: finalityClient(990n), head: 1070n },
  ]);
  assert.equal(boundary, 1000n);
  assert.deepEqual(providers.map((p) => [p.finalized, p.source]), [[1000n, 'tag'], [990n, 'tag']]);
});

test('a provider claiming finalized = 0 cannot lower the boundary', async () => {
  const { boundary } = await getFinality([
    { client: finalityClient(1000n), head: 1070n },
    { client: finalityClient(0n), head: 1070n },
  ]);
  assert.equal(boundary, 1000n);
});

test('a finality claim above the provider\'s own head is capped at its head', async () => {
  const { boundary, providers } = await getFinality([{ client: finalityClient(5000n), head: 1070n }]);
  assert.equal(providers[0].finalized, 1070n);
  assert.equal(boundary, 1070n);
});

test('providers without the finalized tag fall back to head minus confirmations', async () => {
  const providers = [
    { client: finalityClient(new Error('f: eth_getBlockByNumber failed: unknown block tag')), head: 1000n },
    { client: finalityClient(null), head: 1010n },
  ];
  const result = await getFinality(providers);
  assert.equal(result.boundary, 1010n - 64n);
  assert.deepEqual(result.providers.map((p) => p.source), ['confirmations', 'confirmations']);
  assert.equal((await getFinality(providers, 10n)).boundary, 1000n);
  assert.equal((await getFinality([{ client: finalityClient(null), head: 5n }])).boundary, 0n);
});

test('regression: a liar cannot excuse a deep forgery as a reorg by claiming low finality', async () => {
  // The forged block sits ~1000 blocks below the head, long past finality.
  // Before the fix, the liar's finalized = 0 became the boundary and the
  // forgery was classified 'unfinalized' (exit 2) instead of 'conflict'.
  const target = first + 2n;
  const head = last + 1000n;
  const fake = forged(sequence[2], { miner: '0x000000000000000000000000000000000000dead' });
  const honest = { ...mockClient('honest'), request: finalityClient(head - 64n).request };
  const liar = { ...mockClient('liar', { edit: { [target]: fake } }), request: finalityClient(0n).request };

  const { boundary } = await getFinality([{ client: honest, head }, { client: liar, head }]);
  const { disagreements } = await compareRange({ clients: [honest, liar], from: first, to: last });
  assert.deepEqual(disagreements.map((d) => [d.number, kindOf(d, boundary)]), [[target, 'conflict']]);
});

test('different hashes above the finalized block are unfinalized, below are a conflict', () => {
  const fake = forged(sequence[0], { miner: '0x000000000000000000000000000000000000dead' });
  const result = compareBlock(first, [
    { label: 'a', block: sequence[0] },
    { label: 'b', block: fake },
  ]);
  assert.equal(kindOf(result, first - 1n), 'unfinalized');
  assert.equal(kindOf(result, first), 'conflict');
  assert.equal(kindOf(result), 'conflict'); // no boundary: treat as finalized
  assert.match(describe(result, first - 1n)[0], /not finalized yet/);
});

test('a block whose fields do not match its hash is a conflict even above finality', () => {
  const result = compareBlock(first, [
    { label: 'a', block: sequence[0] },
    { label: 'b', block: { ...sequence[0], gasUsed: '0x1' } },
  ]);
  assert.equal(kindOf(result, first - 1n), 'conflict');
});

test('providers far behind on head or finality are warned about', async () => {
  const labelled = (label, finalized) => ({ ...finalityClient(finalized), label });
  const finality = await getFinality([
    { client: labelled('good', 1000n), head: 1070n },
    { client: labelled('lowball', 0n), head: 1070n },
    { client: labelled('lagging', 800n), head: 870n },
  ]);
  assert.deepEqual(providerWarnings(finality), [
    "lowball reports finalized 0, 1000 blocks behind the others (lagging, or misreporting finality); its claim is not used.",
    "lagging's head is 200 blocks behind the highest; only blocks up to 870 can be compared.",
    'lagging reports finalized 800, 200 blocks behind the others (lagging, or misreporting finality); its claim is not used.',
  ]);
});

test('providers close together produce no warnings', async () => {
  const finality = await getFinality([
    { client: finalityClient(1000n), head: 1070n },
    { client: finalityClient(968n), head: 1066n },
  ]);
  assert.deepEqual(providerWarnings(finality), []);
});
