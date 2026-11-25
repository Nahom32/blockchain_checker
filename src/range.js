import { parseArgs } from 'node:util';

export const DEFAULT_LAST = 100n;

const options = {
  from: { type: 'string' },
  to: { type: 'string' },
  last: { type: 'string' },
  checkpoint: { type: 'string' },
};

function toBlockNumber(name, value) {
  if (!/^\d+$/.test(value)) throw new Error(`--${name} must be a non-negative integer, got "${value}"`);
  return BigInt(value);
}

/**
 * Parse --from, --to and --last into bigints, and --checkpoint into a
 * lowercase block hash. Absent options are undefined.
 */
export function parseRangeArgs(argv) {
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
