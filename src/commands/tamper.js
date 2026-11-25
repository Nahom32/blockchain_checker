import { parseArgs } from 'node:util';
import { createClient, DEFAULT_URL } from '../rpc.js';
import { verifyHeaderHash } from '../header.js';
import { printer } from '../output.js';

export const summary = 'demonstrate that editing a block is detected';

export const usage = `Usage: blockchain-checker tamper [BLOCK]

Fetch a real block (default: the latest) from WEB3_PROVIDER_URL, verify it,
then change its miner in a local copy and show that verification catches it.
Nothing is sent to the node.`;

const NUMBER = /^\d+$/;

function report(print, label, block) {
  const result = verifyHeaderHash(block);
  if (result.valid) {
    print.log(`${label}: valid`);
  } else {
    print.log(`${label}: TAMPERED`);
    print.log(`  reported hash:   ${result.actual}`);
    print.log(`  recomputed hash: ${result.expected ?? `(could not rebuild header: ${result.error})`}`);
  }
  return result.valid;
}

/** @param {string[]} argv @param {import('../output.js').IO} io @returns {Promise<number>} exit code */
export async function run(argv, io) {
  const print = printer(io);
  try {
    const { positionals } = parseArgs({ args: argv, options: {}, allowPositionals: true, strict: true });
    if (positionals.length > 1) throw new Error(`expected at most one block number, got ${positionals.length}`);
    const blockArg = positionals[0] ?? 'latest';
    if (blockArg !== 'latest' && !NUMBER.test(blockArg)) {
      throw new Error(`BLOCK must be a block number or 'latest', got "${blockArg}"`);
    }

    const client = createClient(io.env.WEB3_PROVIDER_URL || DEFAULT_URL);
    const block = await client.getBlock(blockArg === 'latest' ? 'latest' : BigInt(blockArg));
    if (!block) {
      print.error(`Block ${blockArg} not found.`);
      return 1;
    }

    print.log(`Checking block ${BigInt(block.number)} (${block.hash})\n`);
    const originalValid = report(print, 'Original block', block);

    // Simulate tampering by changing the miner (fee recipient) address.
    const tampered = { ...block, miner: '0x0000000000000000000000000000000000000000' };
    if (tampered.miner === block.miner) tampered.miner = '0x0000000000000000000000000000000000000001';
    print.log(`\nChanging miner ${block.miner} -> ${tampered.miner} in a local copy`);
    const tamperedValid = report(print, 'Tampered block', tampered);

    if (!originalValid || tamperedValid) {
      print.error('\nUnexpected result: the original should be valid and the tampered copy invalid.');
      return 1;
    }
    return 0;
  } catch (error) {
    print.error(`Error simulating tampering: ${error.message ?? error}`);
    return 1;
  }
}
