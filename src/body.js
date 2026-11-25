import { genTransactionsTrieRoot } from '@ethereumjs/block';
import { Common, Mainnet } from '@ethereumjs/common';
import { MerklePatriciaTrie } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { createTxFromRPC } from '@ethereumjs/tx';
import { bigIntToUnpaddedBytes, bytesToHex, concatBytes, hexToBytes } from '@ethereumjs/util';
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

/**
 * Consensus encoding of one JSON-RPC receipt, as stored in the receipts trie:
 *   rlp([statusOrRoot, cumulativeGasUsed, logsBloom, logs])
 * prefixed with the transaction type byte for typed (EIP-2718) receipts.
 * Before Byzantium the first field is the post-transaction state root;
 * after it, a status of 1 (success) or empty bytes (failure).
 */
export function encodeReceipt(receipt) {
  const statusOrRoot =
    receipt.root != null
      ? hexToBytes(receipt.root)
      : BigInt(receipt.status) === 1n
        ? Uint8Array.of(1)
        : new Uint8Array();
  const logs = receipt.logs.map((log) => [
    hexToBytes(log.address),
    log.topics.map((topic) => hexToBytes(topic)),
    hexToBytes(log.data),
  ]);
  const payload = RLP.encode([
    statusOrRoot,
    bigIntToUnpaddedBytes(BigInt(receipt.cumulativeGasUsed)),
    hexToBytes(receipt.logsBloom),
    logs,
  ]);
  const type = receipt.type == null ? 0 : Number(BigInt(receipt.type));
  return type === 0 ? payload : concatBytes(Uint8Array.of(type), payload);
}

/**
 * Rebuild the receipts trie and compare its root with the header's
 * receiptsRoot. `receipts` are JSON-RPC receipts for every transaction in
 * the block (see fetchBlockReceipts); they are ordered by transactionIndex.
 *
 * @returns {Promise<{ valid: boolean, expected: string | null, actual: string, error?: string }>}
 */
export async function verifyReceiptsRoot(block, receipts) {
  const actual = String(block.receiptsRoot).toLowerCase();
  let expected;
  try {
    const ordered = [...receipts].sort((a, b) => Number(BigInt(a.transactionIndex) - BigInt(b.transactionIndex)));
    const trie = new MerklePatriciaTrie();
    for (const [i, receipt] of ordered.entries()) await trie.put(RLP.encode(i), encodeReceipt(receipt));
    expected = bytesToHex(trie.root());
  } catch (err) {
    return { valid: false, expected: null, actual, error: err.message };
  }
  if (receipts.length !== block.transactions.length) {
    return {
      valid: false, expected, actual,
      error: `got ${receipts.length} receipts for ${block.transactions.length} transactions`,
    };
  }
  return { valid: expected === actual, expected, actual };
}

/**
 * Fetch every receipt in a block: eth_getBlockReceipts where supported, else
 * one eth_getTransactionReceipt per transaction.
 *
 * @param {(method: string, params: unknown[]) => Promise<any>} request
 */
export async function fetchBlockReceipts(request, block) {
  try {
    const receipts = await request('eth_getBlockReceipts', [block.number]);
    if (Array.isArray(receipts)) return receipts;
  } catch {
    // Not supported by this node: fall back to per-transaction requests.
  }
  const hashes = block.transactions.map((tx) => (typeof tx === 'string' ? tx : tx.hash));
  return Promise.all(hashes.map((hash) => request('eth_getTransactionReceipt', [hash])));
}
