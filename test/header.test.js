import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inferHardfork, verifyHeaderHash } from '../src/header.js';

// Raw eth_getBlockByNumber responses from Ethereum mainnet, one per header
// layout (transaction lists stripped; they are not part of the header).
const blocks = JSON.parse(
  readFileSync(new URL('./fixtures/mainnet-blocks.json', import.meta.url), 'utf8'),
);

const expectedHardfork = {
  genesis: 'berlin',
  frontier: 'berlin',
  daoFork: 'berlin',
  london: 'london',
  merge: 'london',
  shanghai: 'shanghai',
  cancun: 'cancun',
  prague: 'prague',
  osaka: 'prague', // Osaka added no header fields
};

for (const [name, block] of Object.entries(blocks)) {
  test(`untampered mainnet ${name} block ${parseInt(block.number)} verifies`, () => {
    assert.equal(inferHardfork(block), expectedHardfork[name]);
    const result = verifyHeaderHash(block);
    assert.equal(result.expected, block.hash);
    assert.equal(result.valid, true);
  });
}

// Flip the last hex digit of a field so its byte length stays the same.
function tamperValue(value) {
  const last = value.at(-1);
  return value.slice(0, -1) + (last === '0' ? '1' : '0');
}

const headerFields = [
  'parentHash', 'sha3Uncles', 'miner', 'stateRoot', 'transactionsRoot',
  'receiptsRoot', 'logsBloom', 'difficulty', 'number', 'gasLimit', 'gasUsed',
  'timestamp', 'extraData', 'mixHash', 'nonce', 'baseFeePerGas',
  'withdrawalsRoot', 'blobGasUsed', 'excessBlobGas', 'parentBeaconBlockRoot',
  'requestsHash',
];

for (const [name, block] of Object.entries(blocks)) {
  for (const field of headerFields) {
    // Skip fields this layout lacks, and empty extraData ('0x' has no digit to flip).
    if (block[field] == null || block[field] === '0x') continue;

    test(`tampering with ${field} on ${name} block is detected`, () => {
      const tampered = { ...block, [field]: tamperValue(block[field]) };
      const result = verifyHeaderHash(tampered);
      assert.equal(result.valid, false);
      assert.notEqual(result.expected, block.hash);
    });
  }
}

test('a forged hash is detected even when every field is untouched', () => {
  const forged = { ...blocks.prague, hash: tamperValue(blocks.prague.hash) };
  assert.equal(verifyHeaderHash(forged).valid, false);
});

test('the miner change the old tamper_checker.js simulated is detected', () => {
  const tampered = { ...blocks.london, miner: '0x0000000000000000000000000000000000000000' };
  assert.equal(verifyHeaderHash(tampered).valid, false);
});
