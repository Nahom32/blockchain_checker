import { createClient, DEFAULT_URL } from '../rpc.js';
import { verifyFromCheckpoint, verifyRange } from '../chain.js';
import { checkBodyRoots, fetchBlockReceipts } from '../body.js';
import { parseOptions, resolveRange } from '../args.js';
import { printer } from '../output.js';
import { detailsLine, failureBreakdown, retryCounter } from '../summary.js';

export const summary = "check blocks' hashes and links on one node";

export const usage = `Usage: blockchain-checker verify [options]

Recompute each block's header hash and check it links to the previous block,
on the node at WEB3_PROVIDER_URL (default ${DEFAULT_URL}).

Range (default: the last 100 blocks):
  --last N               the last N blocks
  --from A [--to B]      blocks A to B (B defaults to the latest)
  --to B [--last N]      the N blocks ending at B

  --checkpoint HASH      verify backward from a block hash you trust (e.g. a
                         finalized block from a block explorer), so the node
                         itself needn't be trusted; combine with --last/--from
  --full                 also check each block's transactions, receipts and
                         withdrawals roots (slower: fetches full blocks)
  --concurrency N        block requests in flight (default 10)
  --verbose              also list every valid block, not just problems`;

const OPTIONS = ['from', 'to', 'last', 'checkpoint', 'concurrency', 'full', 'verbose'];

/**
 * Block fetching for the chosen mode. With --full, each fetch also gets the
 * block's receipts (so the concurrent prefetch covers them too) and
 * checkBody verifies the body roots.
 */
function fetching(client, args) {
  if (!args.full) {
    return {
      fetchBlock: (n) => client.getBlock(n),
      fetchByHash: (hash) => client.getBlockByHash(hash),
      checkBody: undefined,
    };
  }
  const receiptsOf = new WeakMap();
  const withReceipts = async (block) => {
    if (block) receiptsOf.set(block, await fetchBlockReceipts(client.request, block));
    return block;
  };
  return {
    fetchBlock: async (n) => withReceipts(await client.getBlock(n, true)),
    fetchByHash: async (hash) => withReceipts(await client.getBlockByHash(hash, true)),
    checkBody: (block) => checkBodyRoots(block, receiptsOf.get(block)),
  };
}

/** Lines under the one-line summary: failures by kind, range, time, retries. */
function printDetails(print, { failed, from, to, started, retries }) {
  if (failed.length > 0) print.log(`  Failures: ${failureBreakdown(failed)}.`);
  print.log(detailsLine({ from, to, elapsedMs: Date.now() - started, retries }));
}

async function checkRange(client, args, print, run) {
  const latest = await client.getBlockNumber();
  const { from, to } = resolveRange(args, latest);
  print.log(`Latest block number: ${latest}. Checking blocks ${from} to ${to}.`);

  const { fetchBlock, checkBody } = fetching(client, args);
  const { checked, failed } = await verifyRange({
    from, to, fetchBlock, checkBody, onBlock: print.block, concurrency: args.concurrency,
  });

  print.log(`\nChecked ${checked} blocks: ${checked - failed.length} valid, ${failed.length} failed.`);
  printDetails(print, { failed, from, to, ...run });
  return failed.length === 0;
}

async function checkFromCheckpoint(client, args, print, run) {
  const { fetchBlock, fetchByHash, checkBody } = fetching(client, args);
  const checkpointBlock = await fetchByHash(args.checkpoint);
  if (!checkpointBlock) {
    print.error(`The node has no block with hash ${args.checkpoint}.`);
    return false;
  }

  const { from, to } = resolveRange(args, BigInt(checkpointBlock.number));
  print.log(`Checkpoint ${args.checkpoint} is block ${to}. Checking back to block ${from}.`);

  const { checked, failed, brokenAt } = await verifyFromCheckpoint({
    checkpointHash: args.checkpoint,
    checkpointBlock,
    from,
    fetchBlock,
    checkBody,
    onBlock: print.block,
    concurrency: args.concurrency,
  });

  if (brokenAt !== null) {
    print.error(`\nChain of trust broken at block ${brokenAt}; blocks ${from} to ${brokenAt} are not verified.`);
    printDetails(print, { failed, from: brokenAt, to, ...run });
    return false;
  }
  print.log(`\nAll ${checked} blocks (${from} to ${to}) are tied to the checkpoint.`);
  if (failed.length > 0) print.error(`${failed.length} of them have contents that don't match their header.`);
  printDetails(print, { failed, from, to, ...run });
  return failed.length === 0;
}

/** @param {string[]} argv @param {import('../output.js').IO} io @returns {Promise<number>} exit code */
export async function run(argv, io) {
  const print = printer(io);
  let verbose = false;
  print.block = ({ number, problems }) => {
    if (problems.length === 0) {
      if (verbose) print.log(`Block ${number} is valid.`);
    } else {
      print.error(`Block ${number} FAILED:`);
      for (const problem of problems) print.error(`  - ${problem}`);
    }
  };

  try {
    const args = parseOptions(argv, OPTIONS);
    verbose = Boolean(args.verbose);
    const run = { started: Date.now(), retries: retryCounter() };
    const client = createClient(io.env.WEB3_PROVIDER_URL || DEFAULT_URL, undefined, { onRetry: run.retries.onRetry });
    const ok = args.checkpoint
      ? await checkFromCheckpoint(client, args, print, run)
      : await checkRange(client, args, print, run);
    return ok ? 0 : 1;
  } catch (error) {
    print.error(`Error verifying blockchain integrity: ${error.message ?? error}`);
    return 1;
  }
}
