import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ascending, descending, fetchInOrder } from '../src/fetch.js';

function trackingFetcher({ delays = () => 0, failOn } = {}) {
  const stats = { inFlight: 0, maxInFlight: 0, started: 0 };
  const fetchBlock = async (n) => {
    stats.started++;
    stats.inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    await delay(delays(n));
    stats.inFlight--;
    if (n === failOn) throw new Error(`rpc failed for ${n}`);
    return { number: `0x${n.toString(16)}` };
  };
  return { fetchBlock, stats };
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test('number generators cover the range inclusively', () => {
  assert.deepEqual([...ascending(3n, 6n)], [3n, 4n, 5n, 6n]);
  assert.deepEqual([...descending(6n, 3n)], [6n, 5n, 4n, 3n]);
});

test('results come back in order even when requests finish out of order', async () => {
  // Later blocks finish first.
  const { fetchBlock } = trackingFetcher({ delays: (n) => Number(20n - n) });
  const results = await collect(fetchInOrder(ascending(0n, 19n), fetchBlock, 8));
  assert.deepEqual(results.map(([n]) => n), [...ascending(0n, 19n)]);
  assert.deepEqual(results.map(([, b]) => BigInt(b.number)), [...ascending(0n, 19n)]);
});

test('never exceeds the concurrency limit, and uses it', async () => {
  const { fetchBlock, stats } = trackingFetcher({ delays: () => 5 });
  await collect(fetchInOrder(ascending(0n, 49n), fetchBlock, 7));
  assert.equal(stats.maxInFlight, 7);
});

test('a concurrency of 1 fetches one block at a time', async () => {
  const { fetchBlock, stats } = trackingFetcher({ delays: () => 1 });
  await collect(fetchInOrder(ascending(0n, 9n), fetchBlock, 1));
  assert.equal(stats.maxInFlight, 1);
});

test('a failed request is thrown when its block is reached', async () => {
  const { fetchBlock } = trackingFetcher({ failOn: 5n });
  const seen = [];
  await assert.rejects(async () => {
    for await (const [n] of fetchInOrder(ascending(0n, 9n), fetchBlock, 4)) seen.push(n);
  }, /rpc failed for 5/);
  assert.deepEqual(seen, [0n, 1n, 2n, 3n, 4n]);
});

test('stopping early wastes at most `concurrency` fetches', async () => {
  const { fetchBlock, stats } = trackingFetcher();
  for await (const [n] of fetchInOrder(ascending(0n, 999n), fetchBlock, 10)) {
    if (n === 4n) break;
  }
  assert.ok(stats.started <= 5 + 10, `started ${stats.started} fetches`);
});
