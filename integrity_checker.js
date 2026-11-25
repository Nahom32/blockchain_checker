import { web3, getRawBlock } from './src/provider.js';
import { verifyRange } from './src/chain.js';
import { parseRangeArgs, resolveRange } from './src/range.js';

// Verify each block's header hash and its link to the previous block.
// Usage: node integrity_checker.js [--last N] [--from A] [--to B]
//   Defaults to the last 100 blocks. See src/range.js for how options combine.

async function main() {
  const args = parseRangeArgs(process.argv.slice(2));
  const latest = await web3.eth.getBlockNumber();
  const { from, to } = resolveRange(args, latest);
  console.log(`Latest block number: ${latest}. Checking blocks ${from} to ${to}.`);

  const { checked, failed } = await verifyRange({
    from,
    to,
    fetchBlock: getRawBlock,
    onBlock: ({ number, problems }) => {
      if (problems.length === 0) {
        console.log(`Block ${number} is valid.`);
      } else {
        console.error(`Block ${number} FAILED:`);
        for (const problem of problems) console.error(`  - ${problem}`);
      }
    },
  });

  console.log(`\nChecked ${checked} blocks: ${checked - failed.length} valid, ${failed.length} failed.`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Error verifying blockchain integrity:', error.message ?? error);
  process.exitCode = 1;
});
