// Helpers for the summary commands print at the end of a run.

/**
 * What kind of problem a verify message describes. Matches the messages
 * produced by src/chain.js and src/body.js (test/summary.test.js checks
 * every one is recognised).
 *
 * @returns {'header' | 'link' | 'body' | 'missing' | 'other'}
 */
export function classifyProblem(problem) {
  if (/^block not found$/.test(problem)) return 'missing';
  if (/^header (hash mismatch|could not be rebuilt)/.test(problem)) return 'header';
  if (/^(transactions|receipts|withdrawals) root /.test(problem)) return 'body';
  if (/^(parentHash |expected block |asked for block |genesis parentHash |fields hash to )/.test(problem)) return 'link';
  return 'other';
}

const KIND_LABELS = {
  header: ['header hash mismatch', 'header hash mismatches'],
  link: ['broken link', 'broken links'],
  body: ['contents mismatch', 'contents mismatches'],
  missing: ['missing block', 'missing blocks'],
  other: ['other problem', 'other problems'],
};

/** e.g. "1 header hash mismatch, 2 broken links" for a list of failed blocks. */
export function failureBreakdown(failed) {
  const counts = {};
  for (const { problems } of failed) {
    for (const kind of new Set(problems.map(classifyProblem))) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return Object.keys(KIND_LABELS)
    .filter((kind) => counts[kind])
    .map((kind) => `${counts[kind]} ${KIND_LABELS[kind][counts[kind] === 1 ? 0 : 1]}`)
    .join(', ');
}

export function formatDuration(ms) {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Counts retries per provider; pass `onRetry` to createClient. */
export function retryCounter() {
  const counts = new Map();
  return {
    onRetry: ({ label }) => counts.set(label, (counts.get(label) ?? 0) + 1),
    /** e.g. "eth.drpc.org retried 12 requests", or '' if nothing was retried */
    describe: () =>
      [...counts].map(([label, n]) => `${label} retried ${n} ${n === 1 ? 'request' : 'requests'}`).join(', '),
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
  };
}

/** The details line under a summary: range, duration and any retries. */
export function detailsLine({ from, to, elapsedMs, retries }) {
  const parts = [`Blocks ${from} to ${to} in ${formatDuration(elapsedMs)}`];
  const retried = retries.describe();
  if (retried) parts.push(retried);
  return `  ${parts.join('; ')}.`;
}
