import { genTransactionsTrieRoot } from '@ethereumjs/block';
import { Common, Mainnet } from '@ethereumjs/common';
import { createTxFromRPC } from '@ethereumjs/tx';
import { bytesToHex } from '@ethereumjs/util';
import { inferHardfork } from './header.js';

// Verify that a block's body matches the roots its header commits to.

/**
 * @ethereumjs/tx refuses to build a blob (type 3) transaction without a KZG
 * library, even though KZG is only used to verify blob data, which block
 * bodies never contain. This stub satisfies that check and fails loudly if
 * anything ever does try to use it.
 */
const KZG_UNAVAILABLE = new Proxy(
  {},
  {
    get: (_, name) =>
      // Not a thenable, so awaiting it by accident doesn't call a stub.
      name === 'then'
        ? undefined
        : () => {
            throw new Error(`KZG is not available (tried to call ${String(name)}); blob data cannot be verified`);
          },
  },
);

/**
 * The chain ID the block's transactions are signed for (typed txs carry it).
 * A plain number, as Common's chain config expects (it is JSON-serialized).
 */
function chainIdOf(block) {
  const withId = block.transactions.find((tx) => tx.chainId != null);
  return withId ? Number(BigInt(withId.chainId)) : Mainnet.chainId;
}

function commonFor(block) {
  return new Common({
    chain: { ...Mainnet, chainId: chainIdOf(block) },
    hardfork: inferHardfork(block),
    customCrypto: { kzg: KZG_UNAVAILABLE },
  });
}

/**
 * Rebuild the transaction trie from the block's transactions and compare its
 * root with the header's transactionsRoot. The block must be fetched with
 * full transactions (getRawBlock(n, true)).
 *
 * @returns {Promise<{ valid: boolean, expected: string | null, actual: string, error?: string }>}
 *   `expected` is the root rebuilt from the transactions; `actual` is the
 *   header's. Malformed transactions give valid: false with `error`.
 */
export async function verifyTransactionsRoot(block) {
  const actual = String(block.transactionsRoot).toLowerCase();
  if (block.transactions.some((tx) => typeof tx === 'string')) {
    return { valid: false, expected: null, actual, error: 'block was fetched without full transactions' };
  }

  let expected;
  try {
    const common = commonFor(block);
    const txs = await Promise.all(block.transactions.map((tx) => createTxFromRPC(tx, { common })));
    expected = bytesToHex(await genTransactionsTrieRoot(txs));
  } catch (err) {
    return { valid: false, expected: null, actual, error: err.message };
  }
  return { valid: expected === actual, expected, actual };
}
