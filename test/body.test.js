import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RLP } from '@ethereumjs/rlp';
import { encodeReceipt, fetchBlockReceipts, verifyReceiptsRoot, verifyTransactionsRoot } from '../src/body.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// Full mainnet blocks (with transaction objects). Between them they cover
// every transaction type: 0 legacy, 1 access list (EIP-2930), 2 fee market
// (EIP-1559), 3 blob (EIP-4844), 4 set code (EIP-7702).
const full = load('mainnet-full-blocks.json');
const genesis = { ...load('mainnet-blocks.json').genesis, transactions: [] };

const typesIn = (block) => [...new Set(block.transactions.map((tx) => tx.type))].sort();

/** Tampering must produce a real, different root, not just a parse error. */
function assertRootMismatch(result, label = '') {
  assert.equal(result.error, undefined, `${label} could not be rebuilt: ${result.error}`);
  assert.equal(result.valid, false, `${label} was not detected`);
  assert.notEqual(result.expected, result.actual);
}

test('the fixtures cover every transaction type', () => {
  const all = new Set(Object.values(full).flatMap(typesIn));
  assert.deepEqual([...all].sort(), ['0x0', '0x1', '0x2', '0x3', '0x4']);
});

for (const [name, block] of Object.entries(full)) {
  test(`untampered ${name} block ${parseInt(block.number)} [${typesIn(block)}] has a valid transactions root`, async () => {
    const result = await verifyTransactionsRoot(block);
    assert.equal(result.error, undefined);
    assert.equal(result.expected, block.transactionsRoot);
    assert.equal(result.valid, true);
  });
}

test('an empty block has the empty-trie root', async () => {
  assert.equal((await verifyTransactionsRoot(genesis)).valid, true);
});

const { allModernTypes: block } = full;
const withTxs = (transactions) => ({ ...block, transactions });
const bump = (hex) => `0x${(BigInt(hex) + 1n).toString(16)}`;

for (const type of ['0x0', '0x1', '0x2', '0x3', '0x4']) {
  test(`changing the value of a type ${type} transaction is detected`, async () => {
    const source = Object.values(full).find((b) => b.transactions.some((tx) => tx.type === type));
    const i = source.transactions.findIndex((tx) => tx.type === type);
    const transactions = structuredClone(source.transactions);
    transactions[i].value = bump(transactions[i].value);

    assertRootMismatch(await verifyTransactionsRoot({ ...source, transactions }));
  });
}

test('changing a blob transaction\'s versioned hashes is detected', async () => {
  const transactions = structuredClone(block.transactions);
  const blobTx = transactions.find((tx) => tx.type === '0x3');
  blobTx.blobVersionedHashes[0] = `0x01${'00'.repeat(31)}`;
  assertRootMismatch(await verifyTransactionsRoot(withTxs(transactions)));
});

test('changing a set-code transaction\'s authorization list is detected', async () => {
  const transactions = structuredClone(block.transactions);
  const setCodeTx = transactions.find((tx) => tx.type === '0x4');
  setCodeTx.authorizationList[0].nonce = bump(setCodeTx.authorizationList[0].nonce);
  assertRootMismatch(await verifyTransactionsRoot(withTxs(transactions)));
});

test('dropping, reordering, duplicating or injecting transactions is detected', async () => {
  const txs = block.transactions;
  const variants = {
    dropped: txs.slice(1),
    reordered: [txs[1], txs[0], ...txs.slice(2)],
    duplicated: [...txs, txs[0]],
    injected: [...txs, full.accessList.transactions[0]],
  };
  for (const [name, transactions] of Object.entries(variants)) {
    assertRootMismatch(await verifyTransactionsRoot(withTxs(transactions)), name);
  }
});

test('a block fetched without full transactions is reported, not mis-verified', async () => {
  const hashesOnly = withTxs(block.transactions.map((tx) => tx.hash));
  const result = await verifyTransactionsRoot(hashesOnly);
  assert.equal(result.valid, false);
  assert.match(result.error, /without full transactions/);
});

test('a malformed transaction gives valid: false with an error instead of throwing', async () => {
  const transactions = structuredClone(block.transactions);
  transactions[0].r = '0xzz';
  const result = await verifyTransactionsRoot(withTxs(transactions));
  assert.equal(result.valid, false);
  assert.equal(result.expected, null);
  assert.ok(result.error);
});

// --- receipts ---------------------------------------------------------------


const receipts = load('mainnet-receipts.json');

for (const [name, blk] of Object.entries(full)) {
  test(`untampered ${name} block ${parseInt(blk.number)} has a valid receipts root`, async () => {
    const result = await verifyReceiptsRoot(blk, receipts[name]);
    assert.equal(result.error, undefined);
    assert.equal(result.valid, true);
  });
}

test('pre-Byzantium receipts (state root instead of status) verify', async () => {
  assert.ok(receipts.frontier[0].root);
  assert.equal(receipts.frontier[0].status, undefined);
  assert.equal((await verifyReceiptsRoot(full.frontier, receipts.frontier)).valid, true);
});

test('an empty block has the empty-trie receipts root', async () => {
  assert.equal((await verifyReceiptsRoot(genesis, [])).valid, true);
});

test('receipts are ordered by transactionIndex before hashing', async () => {
  const shuffled = [...receipts.accessList].reverse();
  assert.equal((await verifyReceiptsRoot(full.accessList, shuffled)).valid, true);
});

test('tampering with a receipt is detected', async () => {
  const name = 'allModernTypes';
  const withLogs = receipts[name].findIndex((r) => r.logs.length > 0);
  const edits = {
    status: (r) => { r[0].status = '0x0'; },
    cumulativeGasUsed: (r) => { r[0].cumulativeGasUsed = bump(r[0].cumulativeGasUsed); },
    logData: (r) => { r[withLogs].logs[0].data = '0x01'; },
    logTopic: (r) => { r[withLogs].logs[0].topics[0] = `0x${'11'.repeat(32)}`; },
    droppedLog: (r) => { r[withLogs].logs.pop(); },
    type: (r) => { r[0].type = r[0].type === '0x2' ? '0x0' : '0x2'; },
  };
  for (const [what, edit] of Object.entries(edits)) {
    const tampered = structuredClone(receipts[name]);
    edit(tampered);
    assertRootMismatch(await verifyReceiptsRoot(full[name], tampered), what);
  }
});

test('a missing receipt is reported', async () => {
  const result = await verifyReceiptsRoot(full.accessList, receipts.accessList.slice(1));
  assert.equal(result.valid, false);
  assert.match(result.error, /got 33 receipts for 34 transactions/);
});

test('status is encoded as 0x01 for success and empty bytes for failure', () => {
  const statusOf = (status) => RLP.decode(encodeReceipt({ ...receipts.accessList[0], type: '0x0', status, logs: [] }))[0];
  assert.deepEqual(statusOf('0x1'), Uint8Array.of(1));
  assert.deepEqual(statusOf('0x0'), new Uint8Array());
});

test('fetchBlockReceipts uses eth_getBlockReceipts, or falls back per transaction', async () => {
  const blk = full.accessList;
  const byHash = new Map(receipts.accessList.map((r) => [r.transactionHash, r]));
  const calls = [];

  const modern = async (method, params) => (calls.push(method), receipts.accessList);
  assert.equal((await fetchBlockReceipts(modern, blk)).length, 34);
  assert.deepEqual(calls, ['eth_getBlockReceipts']);

  calls.length = 0;
  const legacy = async (method, params) => {
    calls.push(method);
    if (method === 'eth_getBlockReceipts') throw new Error('method not found');
    return byHash.get(params[0]);
  };
  const fetched = await fetchBlockReceipts(legacy, blk);
  assert.equal(calls.filter((m) => m === 'eth_getTransactionReceipt').length, 34);
  assert.equal((await verifyReceiptsRoot(blk, fetched)).valid, true);
});
