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
  retries: 5, // attempts after the first
  baseDelayMs: 250,
  maxDelayMs: 8_000, // cap for one wait, including a server's Retry-After
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

/**
 * @param {string} url
 * @param {string} [label] display name (never includes credentials)
 * @param {object} [options]
 * @param {Partial<typeof DEFAULT_RETRY>} [options.retry]
 * @param {(info: { label, method, attempt, delayMs, reason }) => void} [options.onRetry]
 * @param {(ms: number) => Promise<void>} [options.sleep] injectable for tests
 */
export function createClient(url, label = labelFor(url), options = {}) {
  const retry = { ...DEFAULT_RETRY, ...options.retry };
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let nextId = 0;

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
      // Network errors can echo the URL; report only the label. The request
      // may or may not have reached the node, so only reads are retried.
      throw new AttemptError(`${label}: ${method} request failed (${err.cause?.code ?? err.name})`, {
        retry: 'read-only',
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
   * exponential backoff (honoring Retry-After); gateway errors and network
   * failures are retried only for read-only methods, since a write may
   * already have been applied.
   */
  async function request(method, params = []) {
    for (let n = 0; ; n++) {
      try {
        return await attempt(method, params);
      } catch (err) {
        const retryable = err.retry === 'always' || (err.retry === 'read-only' && READ_ONLY.test(method));
        if (!retryable || n >= retry.retries) {
          const suffix = retryable && n > 0 ? ` (gave up after ${n} ${n === 1 ? 'retry' : 'retries'})` : '';
          throw new Error(`${err.message}${suffix}`);
        }
        const delayMs = Math.min(retry.maxDelayMs, err.retryAfterMs ?? backoffDelay(n, retry));
        options.onRetry?.({ label, method, attempt: n + 1, delayMs, reason: err.message });
        await sleep(delayMs);
      }
    }
  }

  return {
    label,
    request,
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
