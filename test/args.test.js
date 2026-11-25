import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, resolveRange } from '../src/args.js';

const latest = 1000n;
const range = (argv) => resolveRange(parseOptions(argv), latest);

test('defaults to the last 100 blocks', () => {
  assert.deepEqual(range([]), { from: 901n, to: 1000n });
});

test('--last N checks the last N blocks', () => {
  assert.deepEqual(range(['--last', '10']), { from: 991n, to: 1000n });
});

test('--last larger than the chain starts at genesis', () => {
  assert.deepEqual(resolveRange({ last: 500n }, 20n), { from: 0n, to: 20n });
});

test('--from alone runs to the latest block', () => {
  assert.deepEqual(range(['--from', '950']), { from: 950n, to: 1000n });
});

test('--from and --to give an exact range', () => {
  assert.deepEqual(range(['--from', '5', '--to', '7']), { from: 5n, to: 7n });
});

test('--to with --last counts back from --to', () => {
  assert.deepEqual(range(['--to', '500', '--last', '3']), { from: 498n, to: 500n });
});

test('invalid ranges are rejected', () => {
  assert.throws(() => range(['--from', '1', '--last', '5']), /either --from or --last/);
  assert.throws(() => range(['--from', '9', '--to', '3']), /after --to/);
  assert.throws(() => range(['--to', '1001']), /past the latest/);
  assert.throws(() => range(['--last', '0']), /at least 1/);
  assert.throws(() => range(['--from=-3']), /non-negative integer/);
  assert.throws(() => range(['--from', 'abc']), /non-negative integer/);
  assert.throws(() => range(['--bogus']), /Unknown option/);
});

test('--checkpoint is parsed and validated', () => {
  const hash = '0x' + 'AB'.repeat(32);
  assert.deepEqual(parseOptions(['--checkpoint', hash, '--last', '5']), { last: 5n, checkpoint: hash.toLowerCase() });
  assert.throws(() => parseOptions(['--checkpoint', '0x1234']), /32-byte block hash/);
  assert.throws(() => parseOptions(['--checkpoint', hash, '--to', '5']), /do not combine it with --to/);
});

test('--concurrency is parsed and validated', () => {
  assert.deepEqual(parseOptions(['--concurrency', '4']), { concurrency: 4 });
  assert.throws(() => parseOptions(['--concurrency', '0']), /at least 1/);
  assert.throws(() => parseOptions(['--concurrency', 'x']), /non-negative integer/);
});

test('--confirmations is parsed', () => {
  assert.deepEqual(parseOptions(['--confirmations', '12']), { confirmations: 12n });
  assert.throws(() => parseOptions(['--confirmations', 'x']), /non-negative integer/);
});

test('--full is parsed', () => {
  assert.deepEqual(parseOptions(['--full']), { full: true });
  assert.deepEqual(parseOptions([]), {});
});

test('a command only accepts the options it declares', () => {
  const compareOptions = ['from', 'to', 'last', 'concurrency', 'confirmations'];
  assert.deepEqual(parseOptions(['--last', '5'], compareOptions), { last: 5n });
  assert.throws(() => parseOptions(['--full'], compareOptions), /Unknown option '--full'/);
  assert.throws(() => parseOptions(['--checkpoint', `0x${'ab'.repeat(32)}`], compareOptions), /Unknown option '--checkpoint'/);
});
