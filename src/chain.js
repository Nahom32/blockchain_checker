import { verifyHeaderHash } from './header.js';
import { ascending, descending, fetchInOrder } from './fetch.js';

const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * Check one block on its own (header hash) and against its parent (linkage).
 *
 * Linkage is checked against the parent's *recomputed* hash, not the hash the
 * node reported. A node that edits a block and reports a matching fake hash
 * fails the header check on that block, and the child's parentHash no longer
 * matches what the parent's fields really hash to.
 *
 * @param block  raw JSON-RPC block
 * @param parent result of checkBlock() for the previous block, or null
 * @returns {{ number: bigint, hash: string | null, problems: string[] }}
 *   `hash` is the recomputed hash (null if the header could not be rebuilt).
 */
export function checkBlock(block, parent) {
  const number = BigInt(block.number);
  const problems = [];

  const header = verifyHeaderHash(block);
  if (!header.valid) {
    problems.push(
      header.expected === null
        ? `header could not be rebuilt: ${header.error}`
        : `header hash mismatch: reported ${header.actual}, fields hash to ${header.expected}`,
    );
  }

  if (number === 0n && block.parentHash !== ZERO_HASH) {
    problems.push(`genesis parentHash should be zero, got ${block.parentHash}`);
  }

  if (parent) {
    if (number !== parent.number + 1n) {
      problems.push(`expected block ${parent.number + 1n} after ${parent.number}, got ${number}`);
    } else if (parent.hash !== null && block.parentHash !== parent.hash) {
      problems.push(`parentHash ${block.parentHash} does not match block ${parent.number}'s hash ${parent.hash}`);
    }
  }

  return { number, hash: header.expected, problems };
}

/**
 * Verify blocks `from`..`to` (inclusive, ascending).
 *
 * @param {object} opts
 * @param {bigint} opts.from
 * @param {bigint} opts.to
 * @param {(n: bigint) => Promise<object|null>} opts.fetchBlock raw block fetcher
 * @param {(result: ReturnType<typeof checkBlock>) => void} [opts.onBlock] progress callback
 * @param {number} [opts.concurrency] max requests in flight (see fetchInOrder)
 * @returns {Promise<{ checked: number, failed: ReturnType<typeof checkBlock>[] }>}
 */
export async function verifyRange({ from, to, fetchBlock, onBlock, concurrency }) {
  const failed = [];
  let checked = 0;
  let parent = null;

  for await (const [n, block] of fetchInOrder(ascending(from, to), fetchBlock, concurrency)) {
    const result = block
      ? checkBlock(block, parent)
      : { number: n, hash: null, problems: ['block not found'] };

    checked++;
    if (result.problems.length > 0) failed.push(result);
    onBlock?.(result);
    parent = result;
  }

  return { checked, failed };
}

/**
 * Verify blocks backward from a trusted checkpoint hash down to `from`.
 *
 * The checkpoint block must hash to the trusted hash, and each block below it
 * must hash to its child's parentHash. Every verified block is therefore
 * cryptographically tied to the one hash you trust; the node is not trusted.
 * Verification stops at the first break, since nothing below it is anchored.
 *
 * @param {object} opts
 * @param {string} opts.checkpointHash trusted block hash
 * @param {object} opts.checkpointBlock the block the node returned for that hash
 * @param {bigint} opts.from lowest block number to verify
 * @param {(n: bigint) => Promise<object|null>} opts.fetchBlock
 * @param {(result: object) => void} [opts.onBlock]
 * @param {number} [opts.concurrency] max requests in flight (see fetchInOrder)
 * @returns {Promise<{ checked: number, failed: object[], brokenAt: bigint | null }>}
 */
export async function verifyFromCheckpoint({ checkpointHash, checkpointBlock, from, fetchBlock, onBlock, concurrency }) {
  let trustedHash = checkpointHash.toLowerCase();
  let checked = 0;

  const top = BigInt(checkpointBlock.number);
  const fetchOrReuse = (n) => (n === top ? Promise.resolve(checkpointBlock) : fetchBlock(n));

  for await (const [n, block] of fetchInOrder(descending(top, from), fetchOrReuse, concurrency)) {
    const problems = [];
    let hash = null;

    if (!block) {
      problems.push('block not found');
    } else {
      const header = verifyHeaderHash(block);
      hash = header.expected;
      if (BigInt(block.number) !== n) {
        problems.push(`asked for block ${n}, got ${BigInt(block.number)}`);
      } else if (hash === null) {
        problems.push(`header could not be rebuilt: ${header.error}`);
      } else if (hash !== trustedHash) {
        problems.push(
          checked === 0
            ? `fields hash to ${hash}, not the checkpoint ${trustedHash}`
            : `fields hash to ${hash}, but block ${n + 1n} says its parent is ${trustedHash}`,
        );
      }
      if (problems.length === 0 && n === 0n && block.parentHash !== ZERO_HASH) {
        problems.push(`genesis parentHash should be zero, got ${block.parentHash}`);
      }
    }

    checked++;
    const result = { number: n, hash, problems };
    onBlock?.(result);
    if (problems.length > 0) return { checked, failed: [result], brokenAt: n };
    trustedHash = block.parentHash.toLowerCase();
  }

  return { checked, failed: [], brokenAt: null };
}
