import 'dotenv/config';
import { network } from 'hardhat';
import { clientsFromEnv, labelFor, providerUrlsFromEnv } from '../src/rpc.js';
import { compareRange, describe, finalizedBoundary, kindOf } from '../src/compare.js';

// End-to-end check of provider comparison against a Hardhat mainnet fork.
//
// Forks mainnet a little below the finalized block, mines a few local blocks
// on top, then compares the fork with a real mainnet RPC. Blocks up to the
// fork point must agree; the locally mined ones must be reported as
// disagreements on finalized blocks.
//
// Uses WEB3_PROVIDER_URLS: the first URL is the mainnet reference, the last
// is the RPC Hardhat forks from (they may be the same). Some RPCs refuse
// Hardhat's fork requests (publicnode returns 403), so e.g.:
//   WEB3_PROVIDER_URLS=https://ethereum-rpc.publicnode.com,https://eth.drpc.org npm run check:fork

const FORK_DEPTH = 200n; // fork this far below mainnet's finalized block
const LOCAL_BLOCKS = 5n;
const CONTEXT = 5n; // shared blocks to compare before the fork point

const hex = (n) => `0x${BigInt(n).toString(16)}`;

async function main() {
  const urls = providerUrlsFromEnv();
  const [reference] = clientsFromEnv();
  const forkUrl = urls.at(-1);

  const head = await reference.getBlockNumber();
  const mainnetFinalized = await finalizedBoundary([{ client: reference, head }]);
  const forkBlock = mainnetFinalized - FORK_DEPTH;
  console.log(`Forking ${labelFor(forkUrl)} at block ${forkBlock} (mainnet finalized: ${mainnetFinalized})`);

  const fork = await network.create({
    override: { forking: { enabled: true, url: forkUrl, blockNumber: forkBlock } },
  });
  try {
    await fork.provider.request({ method: 'hardhat_mine', params: [hex(LOCAL_BLOCKS)] });
    const request = (method, params = []) => fork.provider.request({ method, params });
    const forkClient = {
      label: 'hardhat-fork',
      request,
      getBlock: (n) => request('eth_getBlockByNumber', [hex(n), false]),
    };

    const from = forkBlock - CONTEXT;
    const to = forkBlock + LOCAL_BLOCKS;
    console.log(`Comparing ${reference.label} with the fork, blocks ${from} to ${to}\n`);

    let unexpected = 0;
    await compareRange({
      clients: [reference, forkClient],
      from,
      to,
      onBlock: (result) => {
        const kind = kindOf(result, mainnetFinalized);
        const expected = result.number <= forkBlock ? 'agree' : 'conflict';
        const mark = kind === expected ? 'ok ' : 'UNEXPECTED';
        if (kind !== expected) unexpected++;
        console.log(`${mark} block ${result.number}: ${kind} (expected ${expected})`);
        if (kind !== expected && !result.agreed) console.log(describe(result, mainnetFinalized).join('\n'));
      },
    });

    console.log(
      unexpected === 0
        ? '\nShared history agrees and every locally mined block was reported as a disagreement.'
        : `\n${unexpected} block(s) did not behave as expected.`,
    );
    return unexpected === 0 ? 0 : 1;
  } finally {
    await fork.close();
  }
}

main().then(
  (code) => (process.exitCode = code),
  (error) => {
    console.error('Fork check failed:', error.message ?? error);
    process.exitCode = 1;
  },
);
