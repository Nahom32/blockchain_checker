import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { clientsFromEnv, createClient, labelFor, labelsFor, providerUrlsFromEnv } from '../src/rpc.js';

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
});

test('RPC and HTTP errors name the provider by label only', async () => {
  const client = createClient(`${baseUrl}/http-error?key=SECRET`, 'node-a');
  await assert.rejects(client.getBlockNumber(), /^Error: node-a: eth_blockNumber returned HTTP 503$/);

  const other = createClient(`${baseUrl}/rpc`, 'node-b');
  await assert.rejects(other.request('eth_nope'), /node-b: eth_nope failed: method not found/);
});

test('network failures do not leak the URL', async () => {
  const client = createClient('http://127.0.0.1:1/SECRET', 'down');
  await assert.rejects(client.getBlockNumber(), (err) => {
    assert.match(err.message, /^down: eth_blockNumber request failed/);
    assert.doesNotMatch(err.message, /SECRET/);
    return true;
  });
});
