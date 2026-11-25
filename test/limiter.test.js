import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAimdLimiter, DEFAULT_MAX_CONCURRENCY } from '../src/rpc.js';

const take = async (limiter, n) => Promise.all(Array.from({ length: n }, () => limiter.acquire()));

test('starts at the maximum and queues requests beyond it', async () => {
  const limiter = createAimdLimiter({ max: 3 });
  const tickets = await take(limiter, 3);
  let fourth = false;
  const pending = limiter.acquire().then((t) => ((fourth = true), t));
  await Promise.resolve();
  assert.equal(fourth, false);
  assert.deepEqual(limiter.stats(), { limit: 3, inFlight: 3, waiting: 1 });

  limiter.release(tickets[0], 'other');
  await pending;
  assert.equal(fourth, true);
});

test('a rate limit halves the requests in flight', async () => {
  const limiter = createAimdLimiter({ max: 8 });
  const tickets = await take(limiter, 8);
  limiter.release(tickets[0], 'rate-limited');
  assert.equal(limiter.stats().limit, 4);
});

test('simultaneous rate limits from one burst cut the limit only once', async () => {
  const limiter = createAimdLimiter({ max: 8 });
  const tickets = await take(limiter, 8);
  for (const t of tickets) limiter.release(t, 'rate-limited');
  assert.equal(limiter.stats().limit, 4);

  // A request sent after the cut that is rate-limited again cuts it again.
  const [later] = await take(limiter, 1);
  limiter.release(later, 'rate-limited');
  assert.equal(limiter.stats().limit, 1); // min(4, 1 in flight) / 2, floored at 1
});

test('it halves what is actually in flight, not an unused maximum', async () => {
  const limiter = createAimdLimiter({ max: 10 });
  const tickets = await take(limiter, 4);
  limiter.release(tickets[0], 'rate-limited');
  assert.equal(limiter.stats().limit, 2);
});

test('it never drops below one slot', async () => {
  const limiter = createAimdLimiter({ max: 2 });
  for (let i = 0; i < 5; i++) {
    const [t] = await take(limiter, 1);
    limiter.release(t, 'rate-limited');
  }
  assert.equal(limiter.stats().limit, 1);
  await take(limiter, 1); // still usable
});

test('successes grow it back about one slot per full round, up to the maximum', async () => {
  const limiter = createAimdLimiter({ max: 6 });
  const burst = await take(limiter, 6);
  for (const t of burst) limiter.release(t, 'rate-limited');
  assert.equal(limiter.stats().limit, 3);

  const limits = [];
  for (let round = 0; round < 10; round++) {
    const { limit } = limiter.stats();
    const tickets = await take(limiter, limit); // use every slot
    for (const t of tickets) limiter.release(t, 'success');
    limits.push(limiter.stats().limit);
  }
  // +1/limit per success is slightly under one slot per round (as in TCP).
  const steps = limits.map((l, i) => l - (i === 0 ? 3 : limits[i - 1]));
  assert.ok(steps.every((d) => d >= 0 && d <= 1), `limits ${limits}`);
  assert.ok(limits.indexOf(6) !== -1 && limits.indexOf(6) <= 4, `back to the maximum too slowly: ${limits}`);
  assert.ok(limits.every((l) => l <= 6));
});

test('it does not grow while slots go unused', async () => {
  const limiter = createAimdLimiter({ max: 8 });
  const burst = await take(limiter, 8);
  for (const t of burst) limiter.release(t, 'rate-limited');
  assert.equal(limiter.stats().limit, 4);

  for (let i = 0; i < 50; i++) {
    const [t] = await take(limiter, 1); // one at a time: never using all 4 slots
    limiter.release(t, 'success');
  }
  assert.equal(limiter.stats().limit, 4);
});

test('waiting requests are served in order', async () => {
  const limiter = createAimdLimiter({ max: 1 });
  const [first] = await take(limiter, 1);
  const order = [];
  const waiters = [1, 2, 3].map((i) => limiter.acquire().then((t) => (order.push(i), limiter.release(t, 'success'))));
  limiter.release(first, 'success');
  await Promise.all(waiters);
  assert.deepEqual(order, [1, 2, 3]);
});

test('the default maximum matches the default fetch concurrency', async () => {
  const { DEFAULT_CONCURRENCY } = await import('../src/fetch.js');
  assert.equal(DEFAULT_MAX_CONCURRENCY, DEFAULT_CONCURRENCY);
});
