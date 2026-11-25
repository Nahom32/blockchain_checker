import 'dotenv/config';
import { clientsFromEnv } from './src/rpc.js';
import { compareRange, describe, kindOf } from './src/compare.js';
import { parseRangeArgs, resolveRange } from './src/range.js';

// Compare blocks across several RPC providers (WEB3_PROVIDER_URLS, comma-separated).
// Usage: node compare_providers.js [--last N] [--from A] [--to B] [--concurrency N]
//   Defaults to the last 100 blocks that every reachable provider has.
// Exit code: 0 all agree, 1 providers disagree, 2 only incomplete results.

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
  const args = parseRangeArgs(process.argv.slice(2));
  if (args.checkpoint) throw new Error('--checkpoint is not supported here; use integrity_checker.js');

  const up = await reachable(clientsFromEnv());
  if (up.length < 2) {
    console.error(`Need at least 2 reachable providers to compare, have ${up.length}. Set WEB3_PROVIDER_URLS.`);
    return 1;
  }

  // Only compare blocks every provider should have.
  const latest = up.map((u) => u.head).reduce((a, b) => (a < b ? a : b));
  const { from, to } = resolveRange(args, latest);
  const clients = up.map((u) => u.client);
  console.log(`Comparing blocks ${from} to ${to} across ${clients.length} providers:`);
  for (const { client, head } of up) console.log(`  ${client.label} (head ${head})`);

  const { checked, disagreements } = await compareRange({
    clients, from, to, concurrency: args.concurrency,
    onBlock: (result) => {
      if (!result.agreed) console.log(`\n${describe(result).join('\n')}`);
    },
  });

  const conflicts = disagreements.filter((d) => kindOf(d) === 'conflict').length;
  const incomplete = disagreements.length - conflicts;
  console.log(
    `\nChecked ${checked} blocks: ${checked - disagreements.length} agree, ` +
      `${conflicts} disagree, ${incomplete} incomplete.`,
  );
  return conflicts > 0 ? 1 : incomplete > 0 ? 2 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (error) => {
    console.error('Error comparing providers:', error.message ?? error);
    process.exitCode = 1;
  },
);
