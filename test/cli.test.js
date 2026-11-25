import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { main } from '../src/cli.js';
import { verifyHeaderHash } from '../src/header.js';
import { captureIO, startHardhatHttp } from './helpers/hardhat-http.js';

// The CLI end to end, against an in-process Hardhat chain served over HTTP.

let chain;
let env;

before(async () => {
  chain = await startHardhatHttp();
  env = { WEB3_PROVIDER_URL: chain.url };
  const [from, to] = await chain.rpc('eth_accounts');
  for (let i = 0; i < 3; i++) await chain.rpc('eth_sendTransaction', [{ from, to, value: `0x${(1000 + i).toString(16)}` }]);
  await chain.rpc('hardhat_mine', ['0x2']); // blocks 0..5
});

after(async () => {
  await chain?.close();
});

async function cli(argv, environment = env) {
  const capture = captureIO(environment);
  const code = await main(argv, capture.io);
  return { code, stdout: capture.stdout(), stderr: capture.stderr() };
}

test('with no command, prints usage listing the commands', async () => {
  const { code, stdout } = await cli([]);
  assert.equal(code, 0);
  assert.match(stdout, /^Usage: blockchain-checker <command>/);
  assert.match(stdout, /verify\s+check blocks/);
});

test('an unknown command is an error', async () => {
  const { code, stderr } = await cli(['frobnicate']);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown command 'frobnicate'/);
});

test('verify --help prints its options', async () => {
  const { code, stdout } = await cli(['verify', '--help']);
  assert.equal(code, 0);
  assert.match(stdout, /--checkpoint HASH/);
  assert.match(stdout, /--full/);
});

test('verify checks a range on the node', async () => {
  const { code, stdout } = await cli(['verify', '--from', '0']);
  assert.equal(code, 0);
  assert.match(stdout, /Checking blocks 0 to 5\./);
  assert.match(stdout, /Checked 6 blocks: 6 valid, 0 failed\./);
});

test('verify --full checks body roots (and flags Hardhat\'s genesis quirk)', async () => {
  const fromOne = await cli(['verify', '--full', '--from', '1']);
  assert.equal(fromOne.code, 0);
  assert.match(fromOne.stdout, /Checked 5 blocks: 5 valid, 0 failed\./);

  const fromGenesis = await cli(['verify', '--full', '--from', '0']);
  assert.equal(fromGenesis.code, 1);
  assert.match(fromGenesis.stderr, /Block 0 FAILED:\n {2}- transactions root mismatch/);
});

test('verify --checkpoint verifies back from a trusted hash', async () => {
  const head = await chain.rpc('eth_getBlockByNumber', ['latest', false]);
  const { code, stdout } = await cli(['verify', '--checkpoint', head.hash, '--from', '0']);
  assert.equal(code, 0);
  assert.match(stdout, /All 6 blocks \(0 to 5\) are tied to the checkpoint\./);
});

test('verify rejects options it does not take', async () => {
  const { code, stderr } = await cli(['verify', '--confirmations', '3']);
  assert.equal(code, 1);
  assert.match(stderr, /Unknown option '--confirmations'/);
});

/** A local URL with nothing listening (a port that was just closed). */
async function closedPortUrl() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return `http://127.0.0.1:${port}/`;
}

test('verify reports an unreachable node', async () => {
  const { code, stderr } = await cli(['verify'], { WEB3_PROVIDER_URL: await closedPortUrl() });
  assert.equal(code, 1);
  assert.match(stderr, /Error verifying blockchain integrity: 127\.0\.0\.1:\d+: eth_blockNumber request failed \(ECONNREFUSED\)/);
});

// --- compare ----------------------------------------------------------------

/** A second "provider" on the same chain that forges block `target`. */
async function lyingProvider(target) {
  return startHardhatHttp({
    rpc: chain.rpc,
    transform: (method, params, result) => {
      if (method !== 'eth_getBlockByNumber' || !result || BigInt(result.number) !== target) return result;
      const forged = { ...result, miner: '0x000000000000000000000000000000000000dead' };
      forged.hash = verifyHeaderHash(forged).expected; // self-consistent
      return forged;
    },
  });
}

test('compare: two honest providers agree', async () => {
  const mirror = await startHardhatHttp({ rpc: chain.rpc });
  try {
    const { code, stdout } = await cli(['compare', '--from', '0'], { WEB3_PROVIDER_URLS: `${chain.url},${mirror.url}` });
    assert.equal(code, 0);
    assert.match(stdout, /Comparing blocks 0 to 5 across 2 providers/);
    assert.match(stdout, /Checked 6 blocks: 6 agree, 0 disagree/);
  } finally {
    await mirror.close();
  }
});

test('compare: a provider serving a forged block is reported, exit 1', async () => {
  const liar = await lyingProvider(3n);
  try {
    const { code, stdout } = await cli(['compare', '--from', '0'], { WEB3_PROVIDER_URLS: `${chain.url},${liar.url}` });
    assert.equal(code, 1);
    assert.match(stdout, /Block 3: providers DISAGREE\n {2}0x[0-9a-f]{64} {2}127\.0\.0\.1:\d+\n {2}0x[0-9a-f]{64} {2}127\.0\.0\.1:\d+/);
    assert.match(stdout, /Checked 6 blocks: 5 agree, 1 disagree/);
  } finally {
    await liar.close();
  }
});

test('compare: needs two reachable providers', async () => {
  const { code, stderr } = await cli(['compare'], { WEB3_PROVIDER_URLS: `${chain.url},${await closedPortUrl()}` });
  assert.equal(code, 1);
  assert.match(stderr, /Skipping unreachable provider/);
  assert.match(stderr, /Need at least 2 reachable providers to compare, have 1/);
});

test('compare rejects options it does not take', async () => {
  const { code, stderr } = await cli(['compare', '--full'], { WEB3_PROVIDER_URLS: chain.url });
  assert.equal(code, 1);
  assert.match(stderr, /Unknown option '--full'/);
});

// --- tamper -----------------------------------------------------------------

test('tamper: a real block verifies and an edited copy does not', async () => {
  const { code, stdout } = await cli(['tamper', '3']);
  assert.equal(code, 0);
  assert.match(stdout, /^Checking block 3 \(0x[0-9a-f]{64}\)/);
  assert.match(stdout, /Original block: valid/);
  assert.match(stdout, /Tampered block: TAMPERED\n {2}reported hash: {3}0x[0-9a-f]{64}\n {2}recomputed hash: 0x[0-9a-f]{64}/);
});

test('tamper defaults to the latest block', async () => {
  const { code, stdout } = await cli(['tamper']);
  assert.equal(code, 0);
  assert.match(stdout, /^Checking block 5 /);
});

test('tamper rejects a bad block argument or a missing block', async () => {
  const bad = await cli(['tamper', 'abc']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /BLOCK must be a block number or 'latest', got "abc"/);

  const missing = await cli(['tamper', '999']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Block 999 not found\./);

  const extra = await cli(['tamper', '1', '2']);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /expected at most one block number/);
});

// --- check-local --------------------------------------------------------------

test('check-local sends transactions, mines them and verifies every block', async () => {
  const own = await startHardhatHttp(); // mines blocks, so not the shared chain
  try {
    const { code, stdout } = await cli(['check-local'], { WEB3_PROVIDER_URL: own.url });
    assert.equal(code, 0);
    assert.match(stdout, /block 1 \[prague, 1 txs\]: valid/);
    assert.match(stdout, /All 5 blocks verified\./);
  } finally {
    await own.close();
  }
});

test('check-local takes no arguments', async () => {
  const { code, stderr } = await cli(['check-local', '--last', '3']);
  assert.equal(code, 1);
  assert.match(stderr, /check-local takes no arguments/);
});
