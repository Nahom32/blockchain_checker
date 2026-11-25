import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyTransactionsRoot } from '../src/body.js';

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
