import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkBlock, verifyFromCheckpoint, verifyRange } from '../src/chain.js';
import { verifyHeaderHash } from '../src/header.js';

// Five consecutive mainnet blocks (22431084..22431088), headers only.
const sequence = JSON.parse(
  readFileSync(new URL('./fixtures/mainnet-sequence.json', import.meta.url), 'utf8'),
);
const first = BigInt(sequence[0].number);
const last = BigInt(sequence.at(-1).number);

function fetcherFor(blocks) {
  const byNumber = new Map(blocks.map((b) => [BigInt(b.number), b]));
  return async (n) => byNumber.get(n) ?? null;
}

test('a real consecutive mainnet range verifies', async () => {
  const { checked, failed } = await verifyRange({ from: first, to: last, fetchBlock: fetcherFor(sequence) });
  assert.equal(checked, 5);
  assert.deepEqual(failed, []);
});

test('editing a field breaks that block and its child\'s link', async () => {
  const blocks = structuredClone(sequence);
  blocks[2].gasUsed = '0x1';

  const { failed } = await verifyRange({ from: first, to: last, fetchBlock: fetcherFor(blocks) });
  assert.deepEqual(failed.map((r) => r.number), [first + 2n, first + 3n]);
  assert.match(failed[0].problems[0], /header hash mismatch/);
  assert.match(failed[1].problems[0], /parentHash .* does not match/);
});

test('a forged block with a self-consistent hash is caught by its child\'s link', async () => {
  // A smarter attacker edits a block and reports the hash its new fields
  // produce, so the block passes on its own. Only linkage catches it.
  const blocks = structuredClone(sequence);
  blocks[2].miner = '0x000000000000000000000000000000000000dead';
  blocks[2].hash = verifyHeaderHash(blocks[2]).expected;

  const { failed } = await verifyRange({ from: first, to: last, fetchBlock: fetcherFor(blocks) });
  assert.deepEqual(failed.map((r) => r.number), [first + 3n]);
  assert.match(failed[0].problems[0], /parentHash .* does not match/);
});

test('a missing block is reported', async () => {
  const { failed } = await verifyRange({
    from: first,
    to: last,
    fetchBlock: fetcherFor(sequence.filter((_, i) => i !== 1)),
  });
  assert.equal(failed[0].number, first + 1n);
  assert.deepEqual(failed[0].problems, ['block not found']);
});

test('a block with the wrong number is reported', () => {
  const parent = checkBlock(sequence[0], null);
  const result = checkBlock(sequence[2], parent);
  assert.match(result.problems[0], new RegExp(`expected block ${first + 1n}`));
});

test('genesis must have a zero parentHash', () => {
  const blocks = JSON.parse(readFileSync(new URL('./fixtures/mainnet-blocks.json', import.meta.url), 'utf8'));
  assert.deepEqual(checkBlock(blocks.genesis, null).problems, []);

  const forged = { ...blocks.genesis, parentHash: '0x' + '11'.repeat(32) };
  assert.ok(checkBlock(forged, null).problems.some((p) => p.includes('genesis parentHash')));
});

// --- verifyFromCheckpoint -------------------------------------------------

const top = sequence.at(-1);

function fromCheckpoint(blocks, checkpointHash = top.hash, from = first) {
  const checkpointBlock = blocks.at(-1);
  return verifyFromCheckpoint({ checkpointHash, checkpointBlock, from, fetchBlock: fetcherFor(blocks) });
}

test('a range verifies backward from a trusted checkpoint', async () => {
  const { checked, failed, brokenAt } = await fromCheckpoint(sequence);
  assert.equal(checked, 5);
  assert.deepEqual(failed, []);
  assert.equal(brokenAt, null);
});

test('a checkpoint block that does not match the trusted hash fails immediately', async () => {
  const wrong = '0x' + 'ab'.repeat(32);
  const { checked, brokenAt, failed } = await fromCheckpoint(sequence, wrong);
  assert.equal(checked, 1);
  assert.equal(brokenAt, last);
  assert.match(failed[0].problems[0], /not the checkpoint/);
});

test('a forged block below the checkpoint breaks the chain of trust there', async () => {
  // Even a forgery with a self-consistent hash can't match the parentHash
  // its trusted child commits to.
  const blocks = structuredClone(sequence);
  blocks[1].miner = '0x000000000000000000000000000000000000dead';
  blocks[1].hash = verifyHeaderHash(blocks[1]).expected;

  const { checked, brokenAt, failed } = await fromCheckpoint(blocks);
  assert.equal(brokenAt, first + 1n);
  assert.equal(checked, 4);
  assert.match(failed[0].problems[0], /says its parent is/);
});

test('a node returning the wrong block number is caught', async () => {
  const blocks = structuredClone(sequence);
  const fetchBlock = async (n) => (n === first + 2n ? blocks[0] : fetcherFor(blocks)(n));
  const { brokenAt, failed } = await verifyFromCheckpoint({
    checkpointHash: top.hash, checkpointBlock: blocks.at(-1), from: first, fetchBlock,
  });
  assert.equal(brokenAt, first + 2n);
  assert.match(failed[0].problems[0], /asked for block/);
});
