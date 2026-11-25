import { web3, getRawBlock } from './src/provider.js';
import { verifyRange } from './src/chain.js';

// Verify every block's header hash and its link to the previous block.

async function main() {
  const latest = await web3.eth.getBlockNumber();
  console.log(`Latest block number: ${latest}`);

  const { checked, failed } = await verifyRange({
    from: 0n,
    to: latest,
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
