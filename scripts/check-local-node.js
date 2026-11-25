import { web3, getRawBlock } from '../src/provider.js';
import { inferHardfork, verifyHeaderHash } from '../src/header.js';

// End-to-end check against a local dev chain (start one with `npm run node`).
// Mines a few blocks with transactions, then verifies every block's header
// hash and confirms a tampered copy of each block is detected.

const [from, to] = await web3.eth.getAccounts();
for (let i = 0; i < 3; i++) {
  await web3.eth.sendTransaction({ from, to, value: 1000n + BigInt(i) });
}
await web3.requestManager.send({ method: 'evm_mine', params: [] });

const latest = await web3.eth.getBlockNumber();
let failures = 0;

for (let n = 0n; n <= latest; n++) {
  const block = await getRawBlock(n);
  const result = verifyHeaderHash(block);
  const tampered = verifyHeaderHash({ ...block, miner: '0x00000000000000000000000000000000000000ff' });

  const status = result.valid ? 'valid' : `INVALID (${result.expected ?? result.error})`;
  console.log(`block ${n} [${inferHardfork(block)}, ${block.transactions.length} txs]: ${status}`);
  if (!result.valid) failures++;
  if (tampered.valid) {
    console.log(`  tampered copy of block ${n} was NOT detected`);
    failures++;
  }
}

console.log(failures === 0 ? `\nAll ${latest + 1n} blocks verified.` : `\n${failures} problem(s) found.`);
process.exitCode = failures === 0 ? 0 : 1;
