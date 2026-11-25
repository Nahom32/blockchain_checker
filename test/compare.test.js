import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareBlock, compareRange, fetchFromAll } from '../src/compare.js';
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
