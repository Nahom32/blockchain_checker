// Minimal JSON-RPC client, one per provider, for comparing several nodes.
// Returns raw responses (no web3 formatting), like getRawBlock.

export const DEFAULT_URL = 'http://localhost:8545';
const REQUEST_TIMEOUT_MS = 30_000;

const toTag = (n) => (typeof n === 'string' ? n : `0x${BigInt(n).toString(16)}`);

/**
 * Provider URLs from the environment: WEB3_PROVIDER_URLS (comma-separated),
 * else WEB3_PROVIDER_URL, else the local default. Blank entries and
 * duplicates are dropped.
 */
export function providerUrlsFromEnv(env = process.env) {
  const raw = env.WEB3_PROVIDER_URLS ?? env.WEB3_PROVIDER_URL ?? DEFAULT_URL;
  const urls = [...new Set(raw.split(',').map((u) => u.trim()).filter(Boolean))];
  if (urls.length === 0) return [DEFAULT_URL];
  for (const url of urls) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid provider URL at position ${urls.indexOf(url) + 1}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Provider URL ${labelFor(url)} must use http or https`);
    }
  }
  return urls;
}

/**
 * A display name for a provider that never includes credentials: only the
 * host, since API keys often sit in the path, query or userinfo.
 */
export function labelFor(url) {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

/** Labels for a list of URLs, numbered when two share a host. */
export function labelsFor(urls) {
  const hosts = urls.map(labelFor);
  return hosts.map((host, i) =>
    hosts.filter((h) => h === host).length > 1 ? `${host}#${hosts.slice(0, i + 1).filter((h) => h === host).length}` : host,
  );
}

export const DEFAULT_RETRY = {
  retries: 8, // retries for gateway and network errors
  // Rate limits are retried for up to this long per request instead of a
  // fixed count: free tiers (e.g. drpc's) reject everything for 40-60s once
  // a quota window is used up, which a retry count can't express.
  rateLimitBudgetMs: 120_000,
  baseDelayMs: 500,
  maxDelayMs: 15_000, // cap for one wait, including a server's Retry-After
};

// Methods that only read, so repeating one is always safe.
const READ_ONLY = /^(eth_get|eth_blockNumber$|eth_chainId$|eth_gasPrice$|eth_call$|eth_feeHistory$|net_version$|web3_clientVersion$)/;

// JSON-RPC error codes providers use for rate limiting.
const RATE_LIMIT_CODES = new Set([-32005, 429]);
const RATE_LIMIT_MESSAGE = /rate.?limit|too many requests|limit exceeded/i;

/** A failed attempt, tagged with whether repeating it is safe and useful. */
class AttemptError extends Error {
  constructor(message, { retry, retryAfterMs } = {}) {
    super(message);
    this.retry = retry; // 'always' (request was refused), 'read-only', or undefined (never)
    this.retryAfterMs = retryAfterMs;
  }
}

const PERMANENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);

/**
 * Summarise a fetch() network error. Node puts the system error code on
 * err.cause (or on each of cause.errors when several addresses were tried,
 * e.g. localhost on IPv4 and IPv6). Errors with no code, such as fetch's
 * "bad port" refusal, are not transient; request timeouts are.
 */
export function describeNetworkError(err) {
  const cause = err.cause;
  const code = cause?.code ?? cause?.errors?.find((e) => e.code)?.code;
  if (err.name === 'TimeoutError') return { detail: 'timed out', transient: true };
  if (code) return { detail: code, transient: !PERMANENT_NETWORK_CODES.has(code) };
  return { detail: cause?.message || err.name, transient: false };
}

/** Retry-After as milliseconds: either seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Exponential backoff with full jitter: random in [0, base * 2^attempt], capped. */
export function backoffDelay(attempt, { baseDelayMs, maxDelayMs }, random = Math.random) {
  return Math.min(maxDelayMs, random() * baseDelayMs * 2 ** attempt);
}

export const DEFAULT_MAX_CONCURRENCY = 10;

/**
 * Adaptive limit on concurrent requests to one provider (AIMD, as in TCP
 * congestion control):
 * - a rate limit halves the requests in flight (multiplicative decrease),
 *   once per burst: attempts that were already in flight when it was cut
 *   don't cut it again, so ten simultaneous 429s count as one overload;
 * - each success of a request sent while the window was full (at any point
 *   while it was in flight) grows the limit by 1/limit: about one slot per
 *   full round (additive increase), up to `max`. A limit nobody uses
 *   doesn't grow, so it can't creep up and overload the provider later.
 * It never goes below 1.
 */
export function createAimdLimiter({ max = DEFAULT_MAX_CONCURRENCY } = {}) {
  let limit = max; // fractional; floor(limit) slots are usable
  let inFlight = 0;
  let issued = 0; // sequence number of the last acquired slot
  let cutAt = 0; // sequence number when the limit was last cut
  let fills = 0; // times the window became full
  const waiting = [];

  const slots = () => Math.max(1, Math.floor(limit));
  const grant = () => {
    const ticket = { seq: ++issued, fills };
    inFlight++;
    if (inFlight >= slots()) fills++;
    return ticket;
  };
  const wake = () => {
    while (waiting.length > 0 && inFlight < slots()) waiting.shift()(grant());
  };

  return {
    /** Wait for a free slot. Resolves to a ticket to pass to release(). */
    acquire() {
      if (inFlight < slots() && waiting.length === 0) return Promise.resolve(grant());
      return new Promise((resolve) => waiting.push(resolve));
    },

    /** @param {'success' | 'rate-limited' | 'other'} outcome */
    release(ticket, outcome) {
      const windowWasFull = fills > ticket.fills;
      if (outcome === 'rate-limited' && ticket.seq > cutAt) {
        limit = Math.max(1, Math.min(limit, inFlight) / 2);
        cutAt = issued;
      } else if (outcome === 'success' && windowWasFull) {
        limit = Math.min(max, limit + 1 / limit);
      }
      inFlight--;
      wake();
    },

    stats: () => ({ limit: slots(), inFlight, waiting: waiting.length }),
  };
}

/**
 * @param {string} url
 * @param {string} [label] display name (never includes credentials)
 * @param {object} [options]
 * @param {Partial<typeof DEFAULT_RETRY>} [options.retry]
 * @param {number} [options.maxConcurrency] most requests in flight at once; the
 *   client lowers this on rate limits and raises it back (see createAimdLimiter)
 * @param {(info: { label, method, attempt, delayMs, reason, concurrency }) => void} [options.onRetry]
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable for tests
 * @param {() => number} [options.now] injectable clock for tests
 */
export function createClient(url, label = labelFor(url), options = {}) {
  const retry = { ...DEFAULT_RETRY, ...options.retry };
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const limiter = createAimdLimiter({ max: options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY });
  let nextId = 0;

  // When the provider rate-limits any request, every request to it waits
  // until this time before its next attempt. Without it, concurrent requests
  // back off independently and keep the limit tripped.
  let pausedUntil = 0;
  /** Wait until the client is no longer paused; returns how long that took. */
  async function waitOutPause() {
    const start = now();
    for (let wait = pausedUntil - now(); wait > 0; wait = pausedUntil - now()) await sleep(wait);
    return now() - start;
  }

  async function attempt(method, params) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network errors can echo the URL; report only the label.
      const { detail, transient } = describeNetworkError(err);
      // A transient failure may or may not have reached the node, so only
      // reads are retried. A refused connection or unknown host is not
      // retried at all: nothing is listening, and waiting won't change that.
      throw new AttemptError(`${label}: ${method} request failed (${detail})`, {
        retry: transient ? 'read-only' : undefined,
      });
    }

    if (response.status === 429) {
      throw new AttemptError(`${label}: ${method} returned HTTP 429`, {
        retry: 'always',
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    if (!response.ok) {
      throw new AttemptError(`${label}: ${method} returned HTTP ${response.status}`, {
        retry: [502, 503, 504].includes(response.status) ? 'read-only' : undefined,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }

    const body = await response.json();
    if (body.error) {
      const limited = RATE_LIMIT_CODES.has(body.error.code) || RATE_LIMIT_MESSAGE.test(body.error.message ?? '');
      throw new AttemptError(`${label}: ${method} failed: ${body.error.message}`, {
        retry: limited ? 'always' : undefined,
      });
    }
    return body.result;
  }

  /**
   * Send one JSON-RPC request. Rate-limit responses are retried with
   * exponential backoff (honoring Retry-After) for up to rateLimitBudgetMs of
   * waiting; gateway errors and network failures are retried up to `retries`
   * times, and only for read-only methods, since a write may already have
   * been applied.
   */
  async function request(method, params = []) {
    let rateLimitedMs = 0; // time this request has spent waiting out rate limits
    let failures = 0; // gateway/network retries so far
    for (let n = 0; ; n++) {
      rateLimitedMs += await waitOutPause();
      // Hold a slot only while the request is on the wire, not while waiting.
      const ticket = await limiter.acquire();
      try {
        const result = await attempt(method, params);
        limiter.release(ticket, 'success');
        return result;
      } catch (err) {
        const rateLimited = err.retry === 'always';
        limiter.release(ticket, rateLimited ? 'rate-limited' : 'other');
        const retryable = rateLimited || (err.retry === 'read-only' && READ_ONLY.test(method));
        const exhausted = rateLimited ? rateLimitedMs >= retry.rateLimitBudgetMs : failures >= retry.retries;
        if (!retryable || exhausted) {
          let suffix = '';
          if (retryable && n > 0) {
            suffix = ` (gave up after ${n} ${n === 1 ? 'retry' : 'retries'}`;
            if (rateLimited) suffix += ` and ${Math.round(rateLimitedMs / 1000)}s of rate limiting`;
            suffix += ')';
          }
          throw new Error(`${err.message}${suffix}`);
        }
        if (!rateLimited) failures++;
        const delayMs = Math.min(retry.maxDelayMs, err.retryAfterMs ?? backoffDelay(n, retry));
        options.onRetry?.({
          label, method, attempt: n + 1, delayMs, reason: err.message, concurrency: limiter.stats().limit,
        });
        if (err.retry === 'always') {
          // Rate limited: pause the whole client, not just this request.
          pausedUntil = Math.max(pausedUntil, now() + delayMs);
          rateLimitedMs += await waitOutPause();
        } else {
          await sleep(delayMs);
        }
      }
    }
  }

  return {
    label,
    request,
    /** Current concurrency limit and load, e.g. to report how far it backed off. */
    stats: limiter.stats,
    // fullTransactions: true returns transaction objects instead of hashes.
    getBlock: (n, fullTransactions = false) => request('eth_getBlockByNumber', [toTag(n), fullTransactions]),
    getBlockByHash: (hash, fullTransactions = false) => request('eth_getBlockByHash', [hash, fullTransactions]),
    getBlockNumber: async () => BigInt(await request('eth_blockNumber')),
  };
}

/** One client per configured provider URL. */
export function clientsFromEnv(env = process.env) {
  const urls = providerUrlsFromEnv(env);
  const labels = labelsFor(urls);
  return urls.map((url, i) => createClient(url, labels[i]));
}
