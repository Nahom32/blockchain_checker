import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { verifyFromCheckpoint, verifyRange } from '../src/chain.js';
import { fetchBlockReceipts, verifyReceiptsRoot, verifyTransactionsRoot, verifyWithdrawalsRoot } from '../src/body.js';

// Range and checkpoint verification against a real local chain. Hardhat runs
// the chain in this process, so no separate node is needed.

let connection;
let provider;
let latest;

const rpc = (method, params = []) => provider.request({ method, params });
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const fetchBlock = (n) => rpc('eth_getBlockByNumber', [hex(n), false]);
const blockAt = async (tag) => rpc('eth_getBlockByNumber', [typeof tag === 'string' ? tag : hex(tag), false]);

async function sendValue(value) {
  const [from, to] = await rpc('eth_accounts');
  await rpc('eth_sendTransaction', [{ from, to, value: hex(value) }]);
}

before(async () => {
  connection = await network.create();
  provider = connection.provider;

  // Build a short chain mixing empty blocks and blocks with transactions.
  for (let i = 0; i < 6; i++) await sendValue(1000 + i); // one block per tx (automine)
  await rpc('hardhat_mine', ['0x4']); // four empty blocks
  latest = BigInt((await blockAt('latest')).number);
});

after(async () => {
  await connection?.close();
});

test('the whole local chain verifies from genesis', async () => {
  const { checked, failed } = await verifyRange({ from: 0n, to: latest, fetchBlock });
  assert.equal(checked, Number(latest) + 1);
  assert.deepEqual(failed, []);
});

test('a partial range verifies', async () => {
  const { checked, failed } = await verifyRange({ from: 3n, to: 7n, fetchBlock, concurrency: 2 });
  assert.equal(checked, 5);
  assert.deepEqual(failed, []);
});

test('the chain verifies back to genesis from a checkpoint', async () => {
  const head = await blockAt('latest');
  const { checked, brokenAt } = await verifyFromCheckpoint({
    checkpointHash: head.hash, checkpointBlock: head, from: 0n, fetchBlock,
  });
  assert.equal(brokenAt, null);
  assert.equal(checked, Number(latest) + 1);
});

test('a node that tampers with a block is caught in both modes', async () => {
  const target = 4n;
  const tampering = async (n) => {
    const block = await fetchBlock(n);
    return n === target ? { ...block, gasUsed: hex(BigInt(block.gasUsed) + 1n) } : block;
  };

  const range = await verifyRange({ from: 0n, to: latest, fetchBlock: tampering });
  assert.deepEqual(range.failed.map((r) => r.number), [target, target + 1n]);

  const head = await blockAt('latest');
  const fromCheckpoint = await verifyFromCheckpoint({
    checkpointHash: head.hash, checkpointBlock: head, from: 0n, fetchBlock: tampering,
  });
  assert.equal(fromCheckpoint.brokenAt, target);
});

test('a checkpoint from before a reorg does not verify against the new chain', async () => {
  // Build branch A three blocks past `latest`, remember its head as the trusted
  // checkpoint, then rewind and build a different branch B to the same height.
  const snapshot = await rpc('evm_snapshot');
  for (let i = 0; i < 3; i++) await sendValue(7000 + i);
  const headA = await blockAt('latest');

  assert.equal(await rpc('evm_revert', [snapshot]), true);
  for (let i = 0; i < 3; i++) await sendValue(9000 + i);
  const headB = await blockAt('latest');
  assert.equal(headB.number, headA.number);
  assert.notEqual(headB.hash, headA.hash);

  // The node now serves branch B. Checking it against A's head must fail at
  // the first block below the checkpoint, where the branches differ.
  const { brokenAt, failed } = await verifyFromCheckpoint({
    checkpointHash: headA.hash, checkpointBlock: headA, from: latest, fetchBlock,
  });
  assert.equal(brokenAt, BigInt(headA.number) - 1n);
  assert.match(failed[0].problems[0], /says its parent is/);

  // Below the fork point both branches share history, so B's head verifies.
  const fromB = await verifyFromCheckpoint({
    checkpointHash: headB.hash, checkpointBlock: headB, from: 0n, fetchBlock,
  });
  assert.equal(fromB.brokenAt, null);
});

test('a local block with several transaction types has a valid transactions root', async () => {
  const [from, to, other] = await rpc('eth_accounts');
  const gasPrice = hex(BigInt(await rpc('eth_gasPrice')) * 2n);

  // Queue several transactions, then mine them into one block.
  await rpc('evm_setAutomine', [false]);
  try {
    await rpc('eth_sendTransaction', [{ from, to, value: '0x1', type: '0x0', gasPrice }]);
    await rpc('eth_sendTransaction', [
      { from, to: other, value: '0x2', type: '0x1', gasPrice, accessList: [{ address: other, storageKeys: [`0x${'00'.repeat(32)}`] }] },
    ]);
    await rpc('eth_sendTransaction', [{ from, to, value: '0x3', type: '0x2' }]);
    await rpc('eth_sendTransaction', [{ from: other, to: from, value: '0x4' }]);
    await rpc('evm_mine');
  } finally {
    await rpc('evm_setAutomine', [true]);
  }

  const block = await rpc('eth_getBlockByNumber', ['latest', true]);
  assert.equal(block.transactions.length, 4);
  assert.deepEqual([...new Set(block.transactions.map((tx) => tx.type))].sort(), ['0x0', '0x1', '0x2']);

  const result = await verifyTransactionsRoot(block);
  assert.equal(result.error, undefined);
  assert.equal(result.valid, true);

  const tampered = structuredClone(block);
  tampered.transactions[1].value = '0x99';
  assert.equal((await verifyTransactionsRoot(tampered)).valid, false);
});

test('a local block with a log and a failed transaction has a valid receipts root', async () => {
  const [from] = await rpc('eth_accounts');
  await rpc('evm_setAutomine', [false]);
  try {
    // Contract creation running PUSH1 0, PUSH1 0, LOG0: succeeds, emits one log.
    await rpc('eth_sendTransaction', [{ from, data: '0x60006000a0', gas: '0x186a0' }]);
    // Contract creation running INVALID: always fails (status 0).
    await rpc('eth_sendTransaction', [{ from, data: '0xfe', gas: '0x186a0' }]);
    await rpc('evm_mine');
  } finally {
    await rpc('evm_setAutomine', [true]);
  }

  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  const receipts = await fetchBlockReceipts(rpc, block);
  assert.deepEqual(receipts.map((r) => [r.status, r.logs.length]), [['0x1', 1], ['0x0', 0]]);

  const result = await verifyReceiptsRoot(block, receipts);
  assert.equal(result.error, undefined);
  assert.equal(result.valid, true);

  const tampered = structuredClone(receipts);
  tampered[1].status = '0x1';
  assert.equal((await verifyReceiptsRoot(block, tampered)).valid, false);
});

test('local blocks have a valid (empty) withdrawals root', async () => {
  for (const tag of ['0x0', 'latest']) {
    const block = await rpc('eth_getBlockByNumber', [tag, false]);
    const result = await verifyWithdrawalsRoot(block);
    assert.equal(result.error, undefined);
    assert.equal(result.valid, true);
  }
});
