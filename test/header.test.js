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
