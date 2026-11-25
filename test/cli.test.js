import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { main } from '../src/cli.js';
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
