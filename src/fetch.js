export const DEFAULT_CONCURRENCY = 10;

/** Block numbers from `from` up to `to`, inclusive. */
export function* ascending(from, to) {
  for (let n = from; n <= to; n++) yield n;
}

/** Block numbers from `from` down to `to`, inclusive. */
export function* descending(from, to) {
  for (let n = from; n >= to; n--) yield n;
}

/**
 * Fetch blocks with up to `concurrency` requests in flight, yielding them in
 * the same order as `numbers`. Requests stay `concurrency` ahead of the
 * consumer, so stopping early (e.g. at a broken checkpoint chain) wastes at
 * most that many fetches.
 *
 * @param {Iterable<bigint>} numbers
 * @param {(n: bigint) => Promise<object|null>} fetchBlock
 * @param {number} [concurrency]
 * @returns {AsyncGenerator<[bigint, object|null]>}
 */
export async function* fetchInOrder(numbers, fetchBlock, concurrency = DEFAULT_CONCURRENCY) {
  const iterator = numbers[Symbol.iterator]();
  const pending = [];

  const fill = () => {
    while (pending.length < concurrency) {
      const { value: n, done } = iterator.next();
      if (done) return;
      const request = fetchBlock(n);
      // Errors are rethrown when this request is awaited in order; this only
      // stops Node reporting them as unhandled while earlier ones are awaited.
      request.catch(() => {});
      pending.push([n, request]);
    }
  };

  fill();
  while (pending.length > 0) {
    const [n, request] = pending.shift();
    const block = await request;
    fill();
    yield [n, block];
  }
}
