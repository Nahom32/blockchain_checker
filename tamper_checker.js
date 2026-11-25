import { getRawBlock } from './src/provider.js';
import { verifyHeaderHash } from './src/header.js';

// Demonstrates tamper detection: verify a real block from the node, then
// change one field in a local copy and show that verification catches it.
// Usage: node tamper_checker.js [blockNumber]   (defaults to the latest block)

function report(label, block) {
  const result = verifyHeaderHash(block);
  if (result.valid) {
    console.log(`${label}: valid`);
  } else {
    console.log(`${label}: TAMPERED`);
    console.log(`  reported hash:   ${result.actual}`);
    console.log(`  recomputed hash: ${result.expected ?? `(could not rebuild header: ${result.error})`}`);
  }
  return result.valid;
}

async function simulateTampering() {
  const blockArg = process.argv[2] ?? 'latest';
  const block = await getRawBlock(blockArg === 'latest' ? 'latest' : BigInt(blockArg));
  if (!block) {
    console.error(`Block ${blockArg} not found.`);
    process.exitCode = 1;
    return;
  }

  const number = BigInt(block.number);
  console.log(`Checking block ${number} (${block.hash})\n`);

  const originalValid = report('Original block', block);

  // Simulate tampering by changing the miner (fee recipient) address.
  const tampered = { ...block, miner: '0x0000000000000000000000000000000000000000' };
  if (tampered.miner === block.miner) tampered.miner = '0x0000000000000000000000000000000000000001';
  console.log(`\nChanging miner ${block.miner} -> ${tampered.miner} in a local copy`);
  const tamperedValid = report('Tampered block', tampered);

  if (!originalValid || tamperedValid) {
    console.error('\nUnexpected result: the original should be valid and the tampered copy invalid.');
    process.exitCode = 1;
  }
}

simulateTampering().catch((error) => {
  console.error('Error simulating tampering:', error.message ?? error);
  process.exitCode = 1;
});
