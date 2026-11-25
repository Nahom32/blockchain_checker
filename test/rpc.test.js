import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  backoffDelay, clientsFromEnv, createClient, DEFAULT_RETRY, describeNetworkError, labelFor, labelsFor, parseRetryAfter,
  providerUrlsFromEnv,
} from '../src/rpc.js';

test('WEB3_PROVIDER_URLS is split on commas, trimmed and deduplicated', () => {
  const env = { WEB3_PROVIDER_URLS: ' https://a.example/v1/KEY , https://b.example ,,https://a.example/v1/KEY' };
  assert.deepEqual(providerUrlsFromEnv(env), ['https://a.example/v1/KEY', 'https://b.example']);
});

test('falls back to WEB3_PROVIDER_URL, then the local default', () => {
  assert.deepEqual(providerUrlsFromEnv({ WEB3_PROVIDER_URL: 'https://one.example' }), ['https://one.example']);
  assert.deepEqual(providerUrlsFromEnv({}), ['http://localhost:8545']);
  assert.deepEqual(providerUrlsFromEnv({ WEB3_PROVIDER_URLS: ' , ' }), ['http://localhost:8545']);
});

test('invalid URLs are rejected without echoing them', () => {
  assert.throws(() => providerUrlsFromEnv({ WEB3_PROVIDER_URLS: 'https://ok.example,not a url SECRET' }), (err) => {
    assert.match(err.message, /position 2/);
    assert.doesNotMatch(err.message, /SECRET/);
    return true;
  });
  assert.throws(() => providerUrlsFromEnv({ WEB3_PROVIDER_URLS: 'wss://x.example' }), /http or https/);
});

test('labels never include API keys, credentials or query strings', () => {
  assert.equal(labelFor('https://mainnet.infura.io/v3/SECRETKEY'), 'mainnet.infura.io');
  assert.equal(labelFor('https://user:pass@node.example:8545/?apikey=SECRET'), 'node.example:8545');
});

test('labels are numbered when providers share a host', () => {
  assert.deepEqual(
    labelsFor(['https://a.example/key1', 'https://b.example', 'https://a.example/key2']),
    ['a.example#1', 'b.example', 'a.example#2'],
  );
  assert.deepEqual(clientsFromEnv({ WEB3_PROVIDER_URLS: 'https://x.example,https://y.example' }).map((c) => c.label), [
    'x.example',
    'y.example',
  ]);
});

// --- client against a fake JSON-RPC server ---------------------------------

const noRetry = { retry: { retries: 0 } };

let server;
let baseUrl;
const requests = [];

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      requests.push({ url: req.url, method, params });
      if (new URL(req.url, 'http://x').pathname === '/http-error') {
        res.writeHead(503).end();
        return;
      }
      const reply =
        method === 'eth_blockNumber'
          ? { result: '0x2a' }
          : method === 'eth_getBlockByNumber'
            ? { result: { number: params[0], hash: '0xabc' } }
            : { error: { code: -32601, message: 'method not found' } };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('the client sends raw JSON-RPC requests and returns results', async () => {
  const client = createClient(`${baseUrl}/rpc`);
  assert.equal(await client.getBlockNumber(), 42n);
  assert.deepEqual(await client.getBlock(16n), { number: '0x10', hash: '0xabc' });
  assert.deepEqual(requests.at(-1), { url: '/rpc', method: 'eth_getBlockByNumber', params: ['0x10', false] });

  await client.getBlock(16n, true);
  assert.deepEqual(requests.at(-1).params, ['0x10', true]);
});

test('RPC and HTTP errors name the provider by label only', async () => {
  const client = createClient(`${baseUrl}/http-error?key=SECRET`, 'node-a', noRetry);
  await assert.rejects(client.getBlockNumber(), /^Error: node-a: eth_blockNumber returned HTTP 503$/);

  const other = createClient(`${baseUrl}/rpc`, 'node-b');
  await assert.rejects(other.request('eth_nope'), /node-b: eth_nope failed: method not found/);
});

test('network failures do not leak the URL', async () => {
  const client = createClient('http://127.0.0.1:1/SECRET', 'down', noRetry);
  await assert.rejects(client.getBlockNumber(), (err) => {
    assert.match(err.message, /^down: eth_blockNumber request failed/);
    assert.doesNotMatch(err.message, /SECRET/);
    return true;
  });
});

// --- retries ----------------------------------------------------------------

test('backoff grows exponentially with full jitter and is capped', () => {
  const opts = { baseDelayMs: 100, maxDelayMs: 1000 };
  assert.equal(backoffDelay(0, opts, () => 1), 100);
  assert.equal(backoffDelay(3, opts, () => 1), 800);
  assert.equal(backoffDelay(10, opts, () => 1), 1000);
  assert.equal(backoffDelay(3, opts, () => 0), 0);
  assert.equal(backoffDelay(3, opts, () => 0.5), 400);
});

test('Retry-After is read as seconds or an HTTP date', () => {
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('0.5'), 500);
  const now = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT', now), 3000);
  assert.equal(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now), 0); // in the past
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(null), undefined);
});

/** A server that answers each request with the next scripted response. */
async function scriptedServer(script) {
  const seen = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method } = JSON.parse(body);
      seen.push(method);
      const step = script[Math.min(seen.length - 1, script.length - 1)];
      const payload = step.error ? { error: step.error } : { result: step.result ?? '0x1' };
      res.writeHead(step.status ?? 200, { 'content-type': 'application/json', ...step.headers });
      res.end(step.status && step.status !== 200 ? '' : JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}

/** A client with a fake clock: sleeping advances time instantly. */
function retryingClient(url, extra = {}) {
  const sleeps = [];
  const retries = [];
  let clock = 1_000_000;
  const client = createClient(url, 'node', {
    retry: { retries: 3, baseDelayMs: 100, maxDelayMs: 1000, ...extra },
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    onRetry: (info) => retries.push(info),
  });
  return { client, sleeps, retries };
}

test('HTTP 429 is retried with backoff until it succeeds', async () => {
  const server = await scriptedServer([{ status: 429 }, { status: 429 }, { result: '0x2a' }]);
  try {
    const { client, sleeps, retries } = retryingClient(server.url);
    assert.equal(await client.getBlockNumber(), 42n);
    assert.equal(server.seen.length, 3);
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[0] <= 100 && sleeps[1] <= 200, `delays ${sleeps}`);
    assert.deepEqual(retries.map((r) => [r.attempt, r.method]), [[1, 'eth_blockNumber'], [2, 'eth_blockNumber']]);
    assert.match(retries[0].reason, /HTTP 429/);
  } finally {
    server.close();
  }
});

test('Retry-After is honored, but capped at maxDelayMs', async () => {
  const server = await scriptedServer([
    { status: 429, headers: { 'retry-after': '0.3' } },
    { status: 429, headers: { 'retry-after': '120' } },
    { result: '0x1' },
  ]);
  try {
    const { client, sleeps } = retryingClient(server.url);
    await client.getBlockNumber();
    assert.deepEqual(sleeps, [300, 1000]);
  } finally {
    server.close();
  }
});

test('JSON-RPC rate-limit errors are retried', async () => {
  const server = await scriptedServer([
    { error: { code: -32005, message: 'limit exceeded' } },
    { error: { code: -32000, message: 'Too Many Requests, slow down' } },
    { result: '0x1' },
  ]);
  try {
    const { client } = retryingClient(server.url);
    assert.equal(await client.getBlockNumber(), 1n);
    assert.equal(server.seen.length, 3);
  } finally {
    server.close();
  }
});

test('gateway errors are retried for reads but never for writes', async () => {
  const server = await scriptedServer([{ status: 503 }, { result: '0x1' }]);
  try {
    const { client } = retryingClient(server.url);
    assert.equal(await client.getBlockNumber(), 1n);
    assert.deepEqual(server.seen, ['eth_blockNumber', 'eth_blockNumber']);
  } finally {
    server.close();
  }

  const writeServer = await scriptedServer([{ status: 503 }, { result: '0xhash' }]);
  try {
    const { client } = retryingClient(writeServer.url);
    await assert.rejects(client.request('eth_sendRawTransaction', ['0x00']), /^Error: node: eth_sendRawTransaction returned HTTP 503$/);
    assert.equal(writeServer.seen.length, 1, 'a write must not be sent twice');
  } finally {
    writeServer.close();
  }
});

test('a rate-limited write is retried (429 means it was refused, not applied)', async () => {
  const server = await scriptedServer([{ status: 429 }, { result: '0xhash' }]);
  try {
    const { client } = retryingClient(server.url);
    assert.equal(await client.request('eth_sendRawTransaction', ['0x00']), '0xhash');
  } finally {
    server.close();
  }
});

test('other errors are not retried', async () => {
  for (const step of [{ status: 400 }, { status: 500 }, { error: { code: -32601, message: 'method not found' } }]) {
    const server = await scriptedServer([step, { result: '0x1' }]);
    try {
      const { client, sleeps } = retryingClient(server.url);
      await assert.rejects(client.getBlockNumber());
      assert.equal(server.seen.length, 1, `${JSON.stringify(step)} was retried`);
      assert.deepEqual(sleeps, []);
    } finally {
      server.close();
    }
  }
});

test('rate limits are retried for a time budget, not a retry count', async () => {
  // drpc's free tier rejects everything for 40-60s once its quota window is
  // used up; a fixed count of short waits gave up before that ended.
  const server = await scriptedServer([{ status: 429 }]);
  try {
    const { client, sleeps } = retryingClient(server.url, { retries: 2, rateLimitBudgetMs: 5000, maxDelayMs: 1000 });
    await assert.rejects(
      client.getBlockNumber(),
      /^Error: node: eth_blockNumber returned HTTP 429 \(gave up after \d+ retries and [56]s of rate limiting\)$/,
    );
    const waited = sleeps.reduce((a, b) => a + b, 0);
    assert.ok(waited >= 5000 && waited < 6000, `waited ${waited}ms`);
    assert.ok(server.seen.length > 3, 'the retry count must not cap rate-limit retries');
  } finally {
    server.close();
  }
});

test('a provider that recovers within the budget succeeds', async () => {
  // 20 rejections in a row (a long penalty window), then it recovers.
  const server = await scriptedServer([...Array(20).fill({ status: 429 }), { result: '0x7' }]);
  try {
    const { client } = retryingClient(server.url, { retries: 2, rateLimitBudgetMs: 60_000 });
    assert.equal(await client.getBlockNumber(), 7n);
    assert.equal(server.seen.length, 21);
  } finally {
    server.close();
  }
});

test('gateway errors give up after the retry count and say so', async () => {
  const server = await scriptedServer([{ status: 503 }]);
  try {
    const { client, sleeps } = retryingClient(server.url, { retries: 2 });
    await assert.rejects(client.getBlockNumber(), /^Error: node: eth_blockNumber returned HTTP 503 \(gave up after 2 retries\)$/);
    assert.equal(server.seen.length, 3);
    assert.equal(sleeps.length, 2);
  } finally {
    server.close();
  }
});

/** A server that accepts connections and immediately drops them. */
async function droppingServer() {
  let connections = 0;
  const srv = createServer();
  srv.on('connection', (socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${srv.address().port}/`, connections: () => connections, close: () => srv.close() };
}

/** A local port with nothing listening on it. */
async function closedPortUrl() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return `http://127.0.0.1:${port}/`;
}

test('dropped connections are retried for reads only', async () => {
  const server = await droppingServer();
  try {
    const reader = retryingClient(server.url, { retries: 2 });
    await assert.rejects(reader.client.getBlockNumber(), /request failed \(\w+\) \(gave up after 2 retries\)$/);
    assert.equal(reader.retries.length, 2);

    const before = server.connections();
    const writer = retryingClient(server.url, { retries: 2 });
    await assert.rejects(writer.client.request('eth_sendRawTransaction', ['0x00']), /request failed \(\w+\)$/);
    assert.equal(writer.retries.length, 0);
    assert.equal(server.connections() - before, 1, 'a write must not be sent twice');
  } finally {
    server.close();
  }
});

test('a refused connection fails at once instead of retrying', async () => {
  const { client, retries, sleeps } = retryingClient(await closedPortUrl(), { retries: 5 });
  await assert.rejects(client.getBlockNumber(), /^Error: node: eth_blockNumber request failed \(ECONNREFUSED\)$/);
  assert.equal(retries.length, 0);
  assert.deepEqual(sleeps, []);
});

test('network errors are classified as transient or permanent', () => {
  const withCause = (cause, name = 'TypeError') => Object.assign(new Error('fetch failed'), { name, cause });
  assert.deepEqual(describeNetworkError(withCause({ code: 'ECONNRESET' })), { detail: 'ECONNRESET', transient: true });
  assert.deepEqual(describeNetworkError(withCause({ code: 'ECONNREFUSED' })), { detail: 'ECONNREFUSED', transient: false });
  assert.deepEqual(describeNetworkError(withCause({ code: 'ENOTFOUND' })), { detail: 'ENOTFOUND', transient: false });
  // localhost tries IPv4 and IPv6; the codes are on cause.errors
  assert.deepEqual(
    describeNetworkError(withCause({ errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] })),
    { detail: 'ECONNREFUSED', transient: false },
  );
  assert.deepEqual(describeNetworkError(withCause({ message: 'bad port' })), { detail: 'bad port', transient: false });
  assert.deepEqual(describeNetworkError(withCause(undefined, 'TimeoutError')), { detail: 'timed out', transient: true });
});

test('the default retry settings are bounded', () => {
  assert.deepEqual(DEFAULT_RETRY, { retries: 8, rateLimitBudgetMs: 120000, baseDelayMs: 500, maxDelayMs: 15000 });
});

test('a rate limit pauses every request to that provider, not just the one that hit it', async () => {
  // The first request is rate-limited with Retry-After: 1s. Requests started
  // during the pause must wait it out instead of hitting the server.
  const server = await scriptedServer([{ status: 429, headers: { 'retry-after': '1' } }, { result: '0x1' }]);
  let clock = 1_000_000;
  const held = []; // sleeps stay pending until the test advances the clock
  const client = createClient(server.url, 'node', {
    retry: { retries: 3, baseDelayMs: 100, maxDelayMs: 5000 },
    now: () => clock,
    sleep: (ms) => new Promise((resolve) => held.push({ ms, resolve })),
  });
  const until = async (condition) => {
    for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(condition(), 'timed out waiting');
  };
  try {
    const first = client.getBlockNumber();
    await until(() => held.length === 1); // the 429 arrived; the client is paused
    assert.equal(held[0].ms, 1000);

    const others = [client.getBlockNumber(), client.getBlockNumber()];
    await until(() => held.length === 3); // both new requests are waiting too
    assert.equal(server.seen.length, 1, 'no request may reach the server during the pause');

    clock += 1000;
    for (const { resolve } of held.splice(0)) resolve();
    assert.deepEqual(await Promise.all([first, ...others]), [1n, 1n, 1n]);
    assert.equal(server.seen.length, 4); // the one 429, then one attempt each
  } finally {
    server.close();
  }
});

// --- adaptive concurrency ---------------------------------------------------

/** A server that rate-limits whenever more than `capacity` requests are in flight. */
async function cappedServer(capacity, latencyMs = 15) {
  let active = 0;
  let peak = 0;
  let served = 0;
  let rejected = 0;
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id } = JSON.parse(body);
      if (active >= capacity) {
        rejected++;
        res.writeHead(429).end();
        return;
      }
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        served++;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }));
      }, latencyMs);
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    stats: () => ({ peak, served, rejected }),
    close: () => srv.close(),
  };
}

test('the client settles at what a rate-limited provider can handle', async () => {
  const { fetchInOrder, ascending } = await import('../src/fetch.js');
  const server = await cappedServer(3);
  try {
    let clock = 0;
    const retries = [];
    const client = createClient(server.url, 'capped', {
      maxConcurrency: 10,
      retry: { retries: 8, baseDelayMs: 1, maxDelayMs: 5 },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        await new Promise((r) => setTimeout(r, 1));
      },
      onRetry: (r) => retries.push(r),
    });

    let done = 0;
    for await (const [, result] of fetchInOrder(ascending(1n, 120n), (n) => client.getBlock(n), 10)) {
      if (result) done++;
    }
    const { served, rejected } = server.stats();
    assert.equal(done, 120);
    assert.equal(served, 120);
    assert.ok(client.stats().limit <= 4, `limit settled at ${client.stats().limit}`);
    // Measured: ~26 rejections with adaptive concurrency, ~1,550 with the
    // limit cut disabled. The bound leaves room for timing variance.
    assert.ok(rejected < 100, `${rejected} rejections`);
  } finally {
    server.close();
  }
});
