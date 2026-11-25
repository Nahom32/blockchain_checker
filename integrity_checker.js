import { web3, getRawBlock, getRawBlockByHash } from './src/provider.js';
import { verifyFromCheckpoint, verifyRange } from './src/chain.js';
import { parseRangeArgs, resolveRange } from './src/range.js';

// Verify each block's header hash and its link to the previous block.
// Usage:
//   node integrity_checker.js [--last N] [--from A] [--to B]
//     Defaults to the last 100 blocks. See src/range.js for how options combine.
//   node integrity_checker.js --checkpoint <trusted block hash> [--last N | --from A]
//     Verify backward from a block hash you trust (e.g. a finalized block from
//     a block explorer). Every verified block is tied to that hash, so the node
//     itself does not need to be trusted.
//   Either mode accepts --concurrency N: max block requests in flight (default 10).

function printBlock({ number, problems }) {
  if (problems.length === 0) {
    console.log(`Block ${number} is valid.`);
  } else {
    console.error(`Block ${number} FAILED:`);
    for (const problem of problems) console.error(`  - ${problem}`);
  }
}

async function checkRange(args) {
  const latest = await web3.eth.getBlockNumber();
  const { from, to } = resolveRange(args, latest);
  console.log(`Latest block number: ${latest}. Checking blocks ${from} to ${to}.`);

  const { checked, failed } = await verifyRange({
    from, to, fetchBlock: getRawBlock, onBlock: printBlock, concurrency: args.concurrency,
  });

  console.log(`\nChecked ${checked} blocks: ${checked - failed.length} valid, ${failed.length} failed.`);
  return failed.length === 0;
}

async function checkFromCheckpoint(args) {
  const checkpointBlock = await getRawBlockByHash(args.checkpoint);
  if (!checkpointBlock) {
    console.error(`The node has no block with hash ${args.checkpoint}.`);
    return false;
  }

  const { from, to } = resolveRange(args, BigInt(checkpointBlock.number));
  console.log(`Checkpoint ${args.checkpoint} is block ${to}. Checking back to block ${from}.`);

  const { checked, brokenAt } = await verifyFromCheckpoint({
    checkpointHash: args.checkpoint,
    checkpointBlock,
    from,
    fetchBlock: getRawBlock,
    onBlock: printBlock,
    concurrency: args.concurrency,
  });

  if (brokenAt === null) {
    console.log(`\nAll ${checked} blocks (${from} to ${to}) are tied to the checkpoint.`);
    return true;
  }
  console.error(`\nChain of trust broken at block ${brokenAt}; blocks ${from} to ${brokenAt} are not verified.`);
  return false;
}

async function main() {
  const args = parseRangeArgs(process.argv.slice(2));
  const ok = args.checkpoint ? await checkFromCheckpoint(args) : await checkRange(args);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Error verifying blockchain integrity:', error.message ?? error);
  process.exitCode = 1;
});
