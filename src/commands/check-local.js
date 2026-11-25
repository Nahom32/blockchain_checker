import { createClient, DEFAULT_URL } from '../rpc.js';
import { parseOptions } from '../args.js';
import { inferHardfork, verifyHeaderHash } from '../header.js';
import { printer } from '../output.js';

export const summary = 'end-to-end check against a local dev chain';

export const usage = `Usage: blockchain-checker check-local [--verbose]

End-to-end check against a local dev chain (start one with 'npm run node'):
sends a few transactions and mines them, then verifies every block's header
hash and confirms an edited copy of each block is detected.

This writes to the chain: only point it at a local dev node.

  --verbose              also list every valid block, not just problems`;

const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** @param {string[]} argv @param {import('../output.js').IO} io @returns {Promise<number>} exit code */
export async function run(argv, io) {
  const print = printer(io);
  try {
    const args = parseOptions(argv, ['verbose']);
    const client = createClient(io.env.WEB3_PROVIDER_URL || DEFAULT_URL);

    const [from, to] = await client.request('eth_accounts');
    if (!from || !to) throw new Error('the node has no unlocked accounts; is this a local dev chain?');
    for (let i = 0; i < 3; i++) {
      await client.request('eth_sendTransaction', [{ from, to, value: hex(1000 + i) }]);
    }
    await client.request('evm_mine');

    const latest = await client.getBlockNumber();
    let failures = 0;
    for (let n = 0n; n <= latest; n++) {
      const block = await client.getBlock(n);
      const result = verifyHeaderHash(block);
      const tampered = verifyHeaderHash({ ...block, miner: '0x00000000000000000000000000000000000000ff' });

      const where = `block ${n} [${inferHardfork(block)}, ${block.transactions.length} txs]`;
      if (!result.valid) {
        print.log(`${where}: INVALID (${result.expected ?? result.error})`);
        failures++;
      } else if (args.verbose) {
        print.log(`${where}: valid`);
      }
      if (tampered.valid) {
        print.log(`  tampered copy of block ${n} was NOT detected`);
        failures++;
      }
    }

    print.log(failures === 0 ? `\nAll ${latest + 1n} blocks verified.` : `\n${failures} problem(s) found.`);
    return failures === 0 ? 0 : 1;
  } catch (error) {
    print.error(`Error checking the local chain: ${error.message ?? error}`);
    return 1;
  }
}
