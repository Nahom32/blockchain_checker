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

export function createClient(url, label = labelFor(url)) {
  let nextId = 0;

  async function request(method, params = []) {
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
      throw new Error(`${label}: ${method} request failed (${err.cause?.code ?? err.name})`);
    }
    if (!response.ok) throw new Error(`${label}: ${method} returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.error) throw new Error(`${label}: ${method} failed: ${body.error.message}`);
    return body.result;
  }

  return {
    label,
    request,
    getBlock: (n) => request('eth_getBlockByNumber', [toTag(n), false]),
    getBlockByHash: (hash) => request('eth_getBlockByHash', [hash, false]),
    getBlockNumber: async () => BigInt(await request('eth_blockNumber')),
  };
}

/** One client per configured provider URL. */
export function clientsFromEnv(env = process.env) {
  const urls = providerUrlsFromEnv(env);
  const labels = labelsFor(urls);
  return urls.map((url, i) => createClient(url, labels[i]));
}
