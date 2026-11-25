import { clientsFromEnv } from '../rpc.js';
import { compareRange, describe, getFinality, kindOf, providerWarnings } from '../compare.js';
import { parseOptions, resolveRange } from '../args.js';
import { printer } from '../output.js';
import { EXIT } from '../exit.js';
import { detailsLine, retryCounter, silent, toJson } from '../summary.js';

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
  --json                 print one machine-readable JSON report instead

Disagreements above the finalized block are reported as likely reorgs. A
block counts as finalized if ANY provider says so, so one provider can't
excuse its forgeries by claiming low finality.

Exit code: 0 all agree, 1 providers disagree on a finalized block,
2 only unfinalized disagreements or incomplete results, 3 couldn't run
(e.g. fewer than 2 reachable providers).`;

const OPTIONS = ['from', 'to', 'last', 'concurrency', 'confirmations', 'verbose', 'json'];

async function reachable(clients, print, skipped) {
  const heads = await Promise.all(
    clients.map(async (client) => {
      try {
        return { client, head: await client.getBlockNumber() };
      } catch (err) {
        print.error(`Skipping unreachable provider ${err.message}`);
        skipped.push({ provider: client.label, error: err.message });
        return null;
      }
    }),
  );
  return heads.filter(Boolean);
}

/** One disagreement as it appears in the JSON report. */
function reportDisagreement(result, finalized) {
  return {
    block: result.number,
    kind: kindOf(result, finalized),
    responses: result.responses.map(({ label, ...rest }) => ({ provider: label, ...rest })),
  };
}

/** @param {string[]} argv @param {import('../output.js').IO} io @returns {Promise<number>} exit code */
export async function run(argv, io) {
  // Known before parsing, so even an argument error is reported as JSON.
  const json = argv.includes('--json');
  const print = json ? silent : printer(io);
  const report = { command: 'compare', skipped: [] };
  const finish = (exitCode) => {
    if (json) io.out.write(toJson({ ...report, exitCode }));
    return exitCode;
  };

  try {
    const args = parseOptions(argv, OPTIONS);
    const started = Date.now();
    const retries = retryCounter();
    const up = await reachable(clientsFromEnv(io.env, { onRetry: retries.onRetry }), print, report.skipped);
    if (up.length < 2) {
      const message = `Need at least 2 reachable providers to compare, have ${up.length}. Set WEB3_PROVIDER_URLS.`;
      print.error(message);
      report.error = message;
      return finish(EXIT.ERROR);
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
    const warnings = providerWarnings(finality, args.confirmations);
    for (const warning of warnings) print.error(`Warning: ${warning}`);
    Object.assign(report, {
      range: { from, to },
      finalized,
      providers: finality.providers.map((p) => ({
        provider: p.label, head: p.head, finalized: p.finalized, finalitySource: p.source,
      })),
      warnings,
    });

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
    const elapsedMs = Date.now() - started;
    print.log(detailsLine({ from, to, elapsedMs, retries }));
    Object.assign(report, {
      checked,
      agree: checked - disagreements.length,
      counts: { conflict: conflicts, unfinalized, incomplete },
      disagreements: disagreements.map((d) => reportDisagreement(d, finalized)),
      elapsedMs,
      retries: retries.byProvider(),
    });
    if (conflicts > 0) return finish(EXIT.PROBLEMS);
    return finish(unfinalized + incomplete > 0 ? EXIT.INCONCLUSIVE : EXIT.OK);
  } catch (error) {
    print.error(`Error comparing providers: ${error.message ?? error}`);
    report.error = error.message ?? String(error);
    return finish(EXIT.ERROR);
  }
}
