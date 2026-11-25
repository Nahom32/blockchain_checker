import { clientsFromEnv } from '../rpc.js';
import { compareRange, describe, getFinality, kindOf, providerWarnings } from '../compare.js';
import { parseOptions, resolveRange } from '../args.js';
import { printer } from '../output.js';
import { detailsLine, retryCounter } from '../summary.js';

export const summary = 'compare blocks across several providers';

export const usage = `Usage: blockchain-checker compare [options]

Fetch each block from every provider in WEB3_PROVIDER_URLS (comma-separated)
and report any disagreement: different hashes, or a block whose fields don't
match its own hash. Reports show each provider's host only, never API keys.

Range (default: the last 100 blocks every reachable provider has):
  --last N               the last N blocks
  --from A [--to B]      blocks A to B
  --to B [--last N]      the N blocks ending at B

  --confirmations N      for providers without a 'finalized' tag, treat blocks
                         this far below the head as final (default 64)
  --concurrency N        block numbers in flight (default 10)
  --verbose              also list every block the providers agree on

Disagreements above the finalized block are reported as likely reorgs. A
block counts as finalized if ANY provider says so, so one provider can't
excuse its forgeries by claiming low finality.

Exit code: 0 all agree, 1 providers disagree on a finalized block,
2 only unfinalized disagreements or incomplete results.`;

const OPTIONS = ['from', 'to', 'last', 'concurrency', 'confirmations', 'verbose'];

async function reachable(clients, print) {
  const heads = await Promise.all(
    clients.map(async (client) => {
      try {
        return { client, head: await client.getBlockNumber() };
      } catch (err) {
        print.error(`Skipping unreachable provider ${err.message}`);
        return null;
      }
    }),
  );
  return heads.filter(Boolean);
}

/** @param {string[]} argv @param {import('../output.js').IO} io @returns {Promise<number>} exit code */
export async function run(argv, io) {
  const print = printer(io);
  try {
    const args = parseOptions(argv, OPTIONS);
    const started = Date.now();
    const retries = retryCounter();
    const up = await reachable(clientsFromEnv(io.env, { onRetry: retries.onRetry }), print);
    if (up.length < 2) {
      print.error(`Need at least 2 reachable providers to compare, have ${up.length}. Set WEB3_PROVIDER_URLS.`);
      return 1;
    }

    // Only compare blocks every provider should have.
    const latest = up.map((u) => u.head).reduce((a, b) => (a < b ? a : b));
    const { from, to } = resolveRange(args, latest);
    const clients = up.map((u) => u.client);
    const finality = await getFinality(up, args.confirmations);
    const finalized = finality.boundary;
    print.log(`Comparing blocks ${from} to ${to} across ${clients.length} providers (finalized up to ${finalized}):`);
    for (const p of finality.providers) {
      const source = p.source === 'tag' ? 'finalized' : 'no finalized tag, assumed';
      print.log(`  ${p.label} (head ${p.head}, ${source} ${p.finalized})`);
    }
    for (const warning of providerWarnings(finality, args.confirmations)) print.error(`Warning: ${warning}`);

    const { checked, disagreements } = await compareRange({
      clients, from, to, concurrency: args.concurrency,
      onBlock: (result) => {
        if (!result.agreed) print.log(`\n${describe(result, finalized).join('\n')}`);
        else if (args.verbose) print.log(`Block ${result.number}: all agree on ${result.responses[0].hash}`);
      },
    });

    const count = (kind) => disagreements.filter((d) => kindOf(d, finalized) === kind).length;
    const conflicts = count('conflict');
    const unfinalized = count('unfinalized');
    const incomplete = count('incomplete');
    print.log(
      `\nChecked ${checked} blocks: ${checked - disagreements.length} agree, ${conflicts} disagree, ` +
        `${unfinalized} disagree before finality, ${incomplete} incomplete.`,
    );
    print.log(detailsLine({ from, to, elapsedMs: Date.now() - started, retries }));
    return conflicts > 0 ? 1 : unfinalized + incomplete > 0 ? 2 : 0;
  } catch (error) {
    print.error(`Error comparing providers: ${error.message ?? error}`);
    return 1;
  }
}
