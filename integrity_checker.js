import { getBlockNumber, getRawBlock, getRawBlockByHash, rawRequest } from './src/provider.js';
import { verifyFromCheckpoint, verifyRange } from './src/chain.js';
import { checkBodyRoots, fetchBlockReceipts } from './src/body.js';
import { parseOptions, resolveRange } from './src/args.js';

// Verify each block's header hash and its link to the previous block.
// Usage:
//   node integrity_checker.js [--last N] [--from A] [--to B]
//     Defaults to the last 100 blocks. See src/args.js for how options combine.
//   node integrity_checker.js --checkpoint <trusted block hash> [--last N | --from A]
//     Verify backward from a block hash you trust (e.g. a finalized block from
//     a block explorer). Every verified block is tied to that hash, so the node
//     itself does not need to be trusted.
//   Either mode accepts --concurrency N: max block requests in flight (default 10),
//   and --full: also check each block's transactions, receipts and withdrawals
//   roots (fetches full transactions and receipts, so it is slower).

/**
 * Block fetching for the chosen mode. With --full, each fetch also gets the
 * block's receipts (so the concurrent prefetch covers them too) and
 * checkBody verifies the body roots.
 */
function fetching(args) {
  if (!args.full) return { fetchBlock: getRawBlock, fetchByHash: getRawBlockByHash, checkBody: undefined };

  const receiptsOf = new WeakMap();
  const withReceipts = async (block) => {
    if (block) receiptsOf.set(block, await fetchBlockReceipts(rawRequest, block));
    return block;
  };
  return {
    fetchBlock: async (n) => withReceipts(await getRawBlock(n, true)),
    fetchByHash: async (hash) => withReceipts(await getRawBlockByHash(hash, true)),
    checkBody: (block) => checkBodyRoots(block, receiptsOf.get(block)),
  };
}

function printBlock({ number, problems }) {
  if (problems.length === 0) {
    console.log(`Block ${number} is valid.`);
  } else {
    console.error(`Block ${number} FAILED:`);
    for (const problem of problems) console.error(`  - ${problem}`);
  }
}

async function checkRange(args) {
  const latest = await getBlockNumber();
  const { from, to } = resolveRange(args, latest);
  console.log(`Latest block number: ${latest}. Checking blocks ${from} to ${to}.`);

  const { fetchBlock, checkBody } = fetching(args);
  const { checked, failed } = await verifyRange({
    from, to, fetchBlock, checkBody, onBlock: printBlock, concurrency: args.concurrency,
  });

  console.log(`\nChecked ${checked} blocks: ${checked - failed.length} valid, ${failed.length} failed.`);
  return failed.length === 0;
}

async function checkFromCheckpoint(args) {
  const { fetchBlock, fetchByHash, checkBody } = fetching(args);
  const checkpointBlock = await fetchByHash(args.checkpoint);
  if (!checkpointBlock) {
    console.error(`The node has no block with hash ${args.checkpoint}.`);
    return false;
  }

  const { from, to } = resolveRange(args, BigInt(checkpointBlock.number));
  console.log(`Checkpoint ${args.checkpoint} is block ${to}. Checking back to block ${from}.`);

  const { checked, failed, brokenAt } = await verifyFromCheckpoint({
    checkpointHash: args.checkpoint,
    checkpointBlock,
    from,
    fetchBlock,
    checkBody,
    onBlock: printBlock,
    concurrency: args.concurrency,
  });

  if (brokenAt !== null) {
    console.error(`\nChain of trust broken at block ${brokenAt}; blocks ${from} to ${brokenAt} are not verified.`);
    return false;
  }
  console.log(`\nAll ${checked} blocks (${from} to ${to}) are tied to the checkpoint.`);
  if (failed.length > 0) {
    console.error(`${failed.length} of them have contents that don't match their header.`);
    return false;
  }
  return true;
}

async function main() {
  const args = parseOptions(process.argv.slice(2), ['from', 'to', 'last', 'checkpoint', 'concurrency', 'full']);
  const ok = args.checkpoint ? await checkFromCheckpoint(args) : await checkRange(args);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error('Error verifying blockchain integrity:', error.message ?? error);
  process.exitCode = 1;
});
