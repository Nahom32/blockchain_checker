import 'dotenv/config';
import { clientsFromEnv } from './src/rpc.js';
import { compareRange, describe, getFinality, kindOf, providerWarnings } from './src/compare.js';
import { parseOptions, resolveRange } from './src/args.js';

// Compare blocks across several RPC providers (WEB3_PROVIDER_URLS, comma-separated).
// Usage: node compare_providers.js [--last N] [--from A] [--to B] [--concurrency N] [--confirmations N]
//   Defaults to the last 100 blocks that every reachable provider has.
//   Disagreements above the finalized block are reported as likely reorgs, not
//   tampering. A block is finalized if ANY provider's 'finalized' tag (or head
//   minus --confirmations, default 64, if unsupported) covers it, so one
//   provider can't excuse its forgeries by claiming low finality.
// Exit code: 0 all agree, 1 providers disagree on a finalized block,
//   2 only unfinalized disagreements or incomplete results.

async function reachable(clients) {
  const heads = await Promise.all(
    clients.map(async (client) => {
      try {
        return { client, head: await client.getBlockNumber() };
      } catch (err) {
        console.error(`Skipping unreachable provider ${err.message}`);
        return null;
      }
    }),
  );
  return heads.filter(Boolean);
}

async function main() {
  const args = parseOptions(process.argv.slice(2), ['from', 'to', 'last', 'concurrency', 'confirmations']);

  const up = await reachable(clientsFromEnv());
  if (up.length < 2) {
    console.error(`Need at least 2 reachable providers to compare, have ${up.length}. Set WEB3_PROVIDER_URLS.`);
    return 1;
  }

  // Only compare blocks every provider should have.
  const latest = up.map((u) => u.head).reduce((a, b) => (a < b ? a : b));
  const { from, to } = resolveRange(args, latest);
  const clients = up.map((u) => u.client);
  const finality = await getFinality(up, args.confirmations);
  const finalized = finality.boundary;
  console.log(`Comparing blocks ${from} to ${to} across ${clients.length} providers (finalized up to ${finalized}):`);
  for (const p of finality.providers) {
    const source = p.source === 'tag' ? 'finalized' : 'no finalized tag, assumed';
    console.log(`  ${p.label} (head ${p.head}, ${source} ${p.finalized})`);
  }
  for (const warning of providerWarnings(finality, args.confirmations)) console.warn(`Warning: ${warning}`);

  const { checked, disagreements } = await compareRange({
    clients, from, to, concurrency: args.concurrency,
    onBlock: (result) => {
      if (!result.agreed) console.log(`\n${describe(result, finalized).join('\n')}`);
    },
  });

  const count = (kind) => disagreements.filter((d) => kindOf(d, finalized) === kind).length;
  const conflicts = count('conflict');
  const unfinalized = count('unfinalized');
  const incomplete = count('incomplete');
  console.log(
    `\nChecked ${checked} blocks: ${checked - disagreements.length} agree, ${conflicts} disagree, ` +
      `${unfinalized} disagree before finality, ${incomplete} incomplete.`,
  );
  return conflicts > 0 ? 1 : unfinalized + incomplete > 0 ? 2 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (error) => {
    console.error('Error comparing providers:', error.message ?? error);
    process.exitCode = 1;
  },
);
