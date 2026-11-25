import { parseArgs } from 'node:util';

export const DEFAULT_LAST = 100n;

const OPTIONS = {
  from: { type: 'string' },
  to: { type: 'string' },
  last: { type: 'string' },
  checkpoint: { type: 'string' },
  concurrency: { type: 'string' },
  confirmations: { type: 'string' },
  full: { type: 'boolean' },
  verbose: { type: 'boolean' },
  json: { type: 'boolean' },
};

export const ALL_OPTIONS = Object.keys(OPTIONS);

function toBlockNumber(name, value) {
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  return BigInt(value);
}

/**
 * Parse command-line options. --from, --to and --last become bigints,
 * --checkpoint a lowercase block hash, --concurrency a number,
 * --confirmations a bigint, and --full, --verbose and --json true. Absent
 * options are undefined.
 *
 * @param {string[]} argv
 * @param {string[]} [allowed] the options this command accepts; any other
 *   option is rejected rather than silently ignored
 */
export function parseOptions(argv, allowed = ALL_OPTIONS) {
  const options = Object.fromEntries(allowed.map((name) => [name, OPTIONS[name]]));
  const { values } = parseArgs({ args: argv, options, strict: true });
  const parsed = {};
  for (const name of ['from', 'to', 'last']) {
    if (values[name] !== undefined) parsed[name] = toBlockNumber(name, values[name]);
  }
  if (values.checkpoint !== undefined) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(values.checkpoint)) {
      throw new Error(`--checkpoint must be a 32-byte block hash (0x + 64 hex digits), got "${values.checkpoint}"`);
    }
    if (parsed.to !== undefined) throw new Error('--checkpoint sets the end of the range; do not combine it with --to');
    parsed.checkpoint = values.checkpoint.toLowerCase();
  }
  if (values.concurrency !== undefined) {
    const concurrency = Number(toBlockNumber('concurrency', values.concurrency));
    if (concurrency < 1) throw new Error('--concurrency must be at least 1');
    parsed.concurrency = concurrency;
  }
  if (values.confirmations !== undefined) parsed.confirmations = toBlockNumber('confirmations', values.confirmations);
  if (values.full) parsed.full = true;
  if (values.verbose) parsed.verbose = true;
  if (values.json) parsed.json = true;
  return parsed;
}

/**
 * Turn range options into a concrete { from, to }.
 *
 *   (nothing)            the last 100 blocks
 *   --last N             the last N blocks
 *   --from A             A..latest
 *   --from A --to B      A..B
 *   --to B [--last N]    the N (default 100) blocks ending at B
 */
export function resolveRange({ from, to, last }, latest) {
  if (from !== undefined && last !== undefined) throw new Error('use either --from or --last, not both');
  if (last !== undefined && last < 1n) throw new Error('--last must be at least 1');

  const end = to ?? latest;
  if (end > latest) throw new Error(`--to ${end} is past the latest block ${latest}`);

  const count = last ?? DEFAULT_LAST;
  const start = from ?? (end - count + 1n > 0n ? end - count + 1n : 0n);
  if (start > end) throw new Error(`--from ${start} is after --to ${end}`);

  return { from: start, to: end };
}
