# Blockchain Integrity Checker

A command-line tool that checks whether the Ethereum blocks an RPC node serves you are genuine. It recomputes block hashes and Merkle roots from the data the node returns, checks that each block links to the one before it, anchors a range of blocks to a hash you trust, and compares what several providers say about the same blocks.

It works with Ethereum mainnet, testnets and local dev chains (Hardhat), across every block format from genesis to the current Prague/Osaka layout.

## What it checks

- **Header hashes.** Rebuilds each block header and recomputes `keccak256(RLP(header))`, so a block whose fields don't match its hash is caught. The header format is inferred from the fields present, so it works on any chain regardless of its upgrade schedule.
- **Links between blocks.** Each block's `parentHash` must equal the hash its parent's fields actually produce, not just the hash the node claims.
- **A trusted checkpoint.** Given a block hash you trust, every block below it must hash to the `parentHash` its child commits to, so the whole range is tied to that one hash and the node itself doesn't need to be trusted.
- **Block contents (`--full`).** Rebuilds the transactions, receipts and withdrawals tries and compares their roots with the header. Covers every transaction type (legacy, access list, EIP-1559, blob, EIP-7702).
- **Several providers (`compare`).** Fetches each block from every provider and reports any disagreement. Disagreements on recent blocks that aren't finalized yet are reported separately as likely reorgs.
- **Unreliable providers.** Rate limits are retried with backoff, and each provider's concurrency adapts to what it can handle. Reports never include API keys from your RPC URLs.

## Requirements

- Node.js and npm. Tested on Node.js 22.18; the `@ethereumjs` packages need Node.js 20 or later.
- An Ethereum JSON-RPC endpoint: a public RPC, your own node, or a local Hardhat chain.

## Installation

```bash
git clone https://github.com/Nahom32/blockchain_checker.git
cd blockchain_checker
npm install
```

Run it with `node src/cli.js <command>` or the npm scripts below. To get a `blockchain-checker` command on your PATH, run `npm link` (this installs a global symlink).

## Configuration

Copy `.env.example` to `.env` and set your endpoints:

```bash
cp .env.example .env
```

| Variable | Used by | Default |
|---|---|---|
| `WEB3_PROVIDER_URL` | `verify`, `tamper`, `check-local` | `http://localhost:8545` (the local Hardhat node) |
| `WEB3_PROVIDER_URLS` | `compare` (comma-separated) | falls back to `WEB3_PROVIDER_URL` |

Environment variables set on the command line override `.env`.

## Usage

```
blockchain-checker <command> [options]

  verify       check blocks' hashes and links on one node
  compare      compare blocks across several providers
  tamper       demonstrate that editing a block is detected
  check-local  end-to-end check against a local dev chain
```

Every command has `--help`. The npm scripts below run the same commands; put options after `--`, for example `npm start -- --last 20` (add `--silent` to hide npm's own header lines). The examples below use `node src/cli.js` so the output shown is exactly what you'll see.

| npm script | Runs |
|---|---|
| `npm start` | `verify` |
| `npm run compare` | `compare` |
| `npm run tamper` | `tamper` |
| `npm run check:local` | `check-local` |
| `npm run node` | starts a local Hardhat chain on port 8545 |
| `npm test` | the test suite (offline) |

### verify: check one node

Checks the last 100 blocks by default. Output is quiet: only problems and a summary.

```console
$ WEB3_PROVIDER_URL=https://ethereum-rpc.publicnode.com node src/cli.js verify
Latest block number: 26491501. Checking blocks 26491402 to 26491501.

Checked 100 blocks: 100 valid, 0 failed.
  Blocks 26491402 to 26491501 in 2.9s.
```

Choose a range with `--last N`, `--from A --to B`, or `--to B --last N`. Add `--verbose` to list every valid block.

**From a trusted checkpoint.** Take a block hash from a source you trust, such as a block explorer, and verify backward from it:

```console
$ node src/cli.js verify --checkpoint 0xf41d74a7b4bdb314b5736317dca3f983a1e4c74861f156229aedd4381a0fd5d3 --last 500
Checkpoint 0xf41d74a7b4bdb314b5736317dca3f983a1e4c74861f156229aedd4381a0fd5d3 is block 26491420. Checking back to block 26490921.

All 500 blocks (26490921 to 26491420) are tied to the checkpoint.
  Blocks 26490921 to 26491420 in 11.0s.
```

If any block's header below the checkpoint was altered, the chain of trust breaks at that block and the output says which blocks are unverified. (With `--full`, a block whose contents don't match its header is reported without breaking the chain, since its header is still tied to the checkpoint.)

**Block contents.** `--full` also checks the transactions, receipts and withdrawals roots. It fetches full blocks and their receipts, so it is slower:

```console
$ node src/cli.js verify --full --last 20
Latest block number: 26491502. Checking blocks 26491483 to 26491502.

Checked 20 blocks: 20 valid, 0 failed.
  Blocks 26491483 to 26491502 in 3.9s.
```

When something fails, each block's problems are listed and the summary counts them by kind (header hash mismatches, broken links, contents mismatches, missing blocks).

### compare: check several providers against each other

```console
$ WEB3_PROVIDER_URLS=https://ethereum-rpc.publicnode.com,https://eth.drpc.org node src/cli.js compare --last 50
Comparing blocks 26491453 to 26491502 across 2 providers (finalized up to 26491420):
  ethereum-rpc.publicnode.com (head 26491502, finalized 26491420)
  eth.drpc.org (head 26491502, finalized 26491420)

Checked 50 blocks: 50 agree, 0 disagree, 0 disagree before finality, 0 incomplete.
  Blocks 26491453 to 26491502 in 2.1s.
```

A disagreement lists every hash with the providers that reported it. Here mainnet is compared with a local Hardhat fork that mined its own blocks after block 26491200:

```console
$ WEB3_PROVIDER_URLS=https://ethereum-rpc.publicnode.com,http://127.0.0.1:8546 node src/cli.js compare --from 26491198 --to 26491203
Comparing blocks 26491198 to 26491203 across 2 providers (finalized up to 26491420):
  ethereum-rpc.publicnode.com (head 26491504, finalized 26491420)
  127.0.0.1:8546 (head 26491203, finalized 26491203)
Warning: 127.0.0.1:8546's head is 301 blocks behind the highest; only blocks up to 26491203 can be compared.
Warning: 127.0.0.1:8546 reports finalized 26491203, 217 blocks behind the others (lagging, or misreporting finality); its claim is not used.

Block 26491201: providers DISAGREE
  0x9083399f570916df196470728e08ef12917862721c660eb9e6e995c217a99fe2  ethereum-rpc.publicnode.com
  0x2fbc807a737e43a3bf94faa194ecf99433cb92efd412858b6c2fa2d126a15386  127.0.0.1:8546

Block 26491202: providers DISAGREE
  0x29183c89d17c71e2b79900d0cd17715a878278b15087eed0431a0e77b35ef572  ethereum-rpc.publicnode.com
  0x802af5e981df12fc233c59839451d81fc9cd817a50df9ba3a60bbef62ef2e74d  127.0.0.1:8546

Block 26491203: providers DISAGREE
  0xe65cb4acc64b109ac7f0e9b477b1ae42ecebe45b1a60017a39e0676498b58d6b  ethereum-rpc.publicnode.com
  0x90a75949694847e53225b54fcd6eab7c9755559a846fe46e1ca9094c7d99a744  127.0.0.1:8546

Checked 6 blocks: 3 agree, 3 disagree, 0 disagree before finality, 0 incomplete.
  Blocks 26491198 to 26491203 in 1.9s.
```

Each fork block hashes correctly on its own, so only comparing providers can catch it. Unreachable providers are skipped with a warning; at least two must respond.

**Finality.** Honest nodes can briefly disagree about the newest blocks during a reorg. Disagreements above the finalized block are therefore reported as "disagree before finality" (exit code 2), not as tampering. A block counts as finalized if *any* provider says so, so one provider can't excuse its own forged blocks by claiming low finality. For providers without a `finalized` tag, `--confirmations N` (default 64) sets how far below the head blocks count as final.

### tamper: see detection in action

Fetches a real block, verifies it, then edits a local copy (nothing is sent to the node):

```console
$ node src/cli.js tamper
Checking block 26491502 (0x5ffbbf664833baa2ca7bb3b421897068db1c9236b9c801bf8e684bda023e99ec)

Original block: valid

Changing miner 0xdadb0d80178819f2319190d340ce9a924f783711 -> 0x0000000000000000000000000000000000000000 in a local copy
Tampered block: TAMPERED
  reported hash:   0x5ffbbf664833baa2ca7bb3b421897068db1c9236b9c801bf8e684bda023e99ec
  recomputed hash: 0x1c0f2a1493ea107ab52288eb0bb9109cc0370426a5c3c5e5e4718f585f3e42e1
```

Pass a block number to use a specific block: `node src/cli.js tamper 46147`.

## Local development with Hardhat

Start a local chain in one terminal:

```bash
npm run node
```

Then, in another terminal (the default `WEB3_PROVIDER_URL` points at it):

```console
$ node src/cli.js check-local

All 5 blocks verified.

$ node src/cli.js verify --from 1 --full
Latest block number: 4. Checking blocks 1 to 4.

Checked 4 blocks: 4 valid, 0 failed.
  Blocks 1 to 4 in 0.0s.
```

`check-local` sends a few transactions and mines them, then verifies every block and confirms an edited copy of each is caught. It writes to the chain, so only point it at a local dev node.

Hardhat's genesis block commits to a non-standard transactions root (`keccak256("")` instead of the empty-trie root), so `--full --from 0` correctly reports block 0 as a contents mismatch on a Hardhat chain. Start from block 1 to skip it.

To compare against a local copy of mainnet, fork it on another port:

```bash
npx hardhat node --fork https://eth.drpc.org --fork-block-number <n> --port 8546
```

`npm run check:fork` does this automatically and checks that shared history agrees and locally mined blocks are flagged. It needs network access; some RPCs (publicnode) refuse Hardhat's fork requests, so fork from another provider (the last URL in `WEB3_PROVIDER_URLS` is the fork source).

## Exit codes and JSON

Every command uses the same exit codes:

| Code | Meaning |
|---|---|
| 0 | every check passed |
| 1 | problems found: tampering, broken links, or providers disagree on a finalized block |
| 2 | inconclusive (`compare` only): disagreements only on unfinalized blocks, or incomplete results |
| 3 | couldn't run: bad arguments, unknown command, unreachable node, too few providers |

`verify` and `compare` accept `--json`: stdout is then exactly one JSON report and nothing else, even for errors, so it can be piped to `jq` or read in CI.

```console
$ npm start --silent -- --last 3 --json
{
  "command": "verify",
  "provider": "ethereum-rpc.publicnode.com",
  "full": false,
  "mode": "range",
  "latest": 26491505,
  "checked": 3,
  "valid": 3,
  "range": {
    "from": 26491503,
    "to": 26491505
  },
  "failed": [],
  "failuresByKind": {},
  "elapsedMs": 693,
  "retries": {},
  "exitCode": 0
}
```

Failed blocks appear in `failed` with each problem's `kind` and `message`. The `compare` report lists every provider, every disagreement with each provider's response, and any skipped providers.

## What it can and cannot detect

It is important to know what a passing check actually proves.

**Detected:**

- A node serving a block whose fields don't match its hash (`verify`).
- A forged block that reports a self-consistent hash, if the block after it is genuine: the child's `parentHash` no longer matches (`verify`).
- Any altered block below a trusted checkpoint, however carefully forged (`verify --checkpoint`).
- Transactions, receipts or withdrawals that differ from what the header commits to: edited, missing, reordered or injected (`verify --full`).
- Providers that disagree about a block (`compare`).

**Not detected:**

- **A node that fabricates a whole consistent chain.** `verify` without `--checkpoint` only shows that the node's blocks are consistent with each other. A dishonest node can build a fake chain where every hash and link is valid. Anchor to a trusted hash with `--checkpoint`, or compare against other providers.
- **All providers lying the same way.** `compare` trusts the providers you give it collectively: it finds disagreement, so it needs at least one honest provider. Use independent providers.
- **Consensus and execution.** It doesn't verify validator signatures or attestations, re-execute transactions, or check the state root, so it can't tell whether a block was validly produced or whether balances and contract state are correct. It checks that the data is the data the header commits to, not that the header itself won consensus.
- **Recent reorgs vs. forgeries.** Above the finalized block, honest disagreement during a reorg can't be told apart from a forgery. These cases get exit code 2. Re-run later: once the blocks are finalized, a real forgery becomes exit code 1 and a reorg disappears.
- **Blob data.** Blob transactions are checked as part of the transactions root, but the blobs themselves (stored on the consensus layer, verified with KZG) are not fetched or checked.

## Rate limits

Public RPCs throttle heavy use. Rate-limited requests are retried with exponential backoff for up to two minutes, honoring `Retry-After`, and each provider's concurrency is halved on a rate limit and grows back as requests succeed. The summary shows how many requests each provider had to retry. A free tier with a request quota still bounds throughput: drpc's public endpoint manages about 7 requests per second, so 1,500 blocks take a few minutes. Lower `--concurrency` or use a dedicated endpoint for large ranges.

## Tests

```bash
npm test
```

The suite runs offline: it uses saved mainnet blocks covering every block and transaction format, and runs Hardhat in-process for chain, CLI and tampering tests. `npm run check:fork` is a separate, network-dependent check against a real mainnet fork.

## Project layout

| Path | Contents |
|---|---|
| `src/cli.js` | command-line entry point |
| `src/commands/` | `verify`, `compare`, `tamper`, `check-local` |
| `src/header.js` | header rebuilding and hash verification |
| `src/chain.js` | range and checkpoint verification |
| `src/body.js` | transactions, receipts and withdrawals roots |
| `src/compare.js` | multi-provider comparison and finality |
| `src/rpc.js` | JSON-RPC client: retries, backoff, adaptive concurrency |
| `scripts/check-fork.js` | end-to-end check against a Hardhat mainnet fork |
| `test/` | test suite and fixtures |

## License

MIT, as declared in `package.json`. There is no separate license file yet.
