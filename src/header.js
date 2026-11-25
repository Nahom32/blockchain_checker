import { createBlockHeader } from '@ethereumjs/block';
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { bytesToHex, setLengthLeft, toBytes } from '@ethereumjs/util';

/**
 * Pick the hardfork whose header layout matches the fields this block has.
 *
 * The header hash only depends on which fields are present, so we infer the
 * fork from the fields instead of the block number. That works on any chain
 * (mainnet, testnets, Ganache, Anvil) regardless of its fork schedule. It
 * matters because @ethereumjs/block fills in defaults for any field the
 * active fork expects but the block lacks, which would change the hash.
 */
export function inferHardfork(block) {
  if (block.blockAccessListHash != null || block.slotNumber != null) return Hardfork.Amsterdam;
  if (block.requestsHash != null) return Hardfork.Prague;
  if (block.parentBeaconBlockRoot != null || block.blobGasUsed != null) return Hardfork.Cancun;
  if (block.withdrawalsRoot != null) return Hardfork.Shanghai;
  if (block.baseFeePerGas != null) return Hardfork.London;
  return Hardfork.Berlin;
}

/**
 * Rebuild an Ethereum block header from JSON-RPC block fields (as returned by
 * a raw eth_getBlockByNumber call).
 */
export function headerFromRpcBlock(block) {
  const common = new Common({ chain: Mainnet, hardfork: inferHardfork(block) });

  return createBlockHeader(
    {
      parentHash: block.parentHash,
      uncleHash: block.sha3Uncles,
      coinbase: block.miner,
      stateRoot: block.stateRoot,
      transactionsTrie: block.transactionsRoot,
      receiptTrie: block.receiptsRoot,
      logsBloom: block.logsBloom,
      difficulty: block.difficulty,
      number: block.number,
      gasLimit: block.gasLimit,
      gasUsed: block.gasUsed,
      timestamp: block.timestamp,
      extraData: block.extraData,
      mixHash: block.mixHash,
      // web3 returns nonce as a number, which loses its fixed 8-byte width.
      nonce: setLengthLeft(toBytes(block.nonce), 8),
      baseFeePerGas: block.baseFeePerGas,
      withdrawalsRoot: block.withdrawalsRoot,
      blobGasUsed: block.blobGasUsed,
      excessBlobGas: block.excessBlobGas,
      parentBeaconBlockRoot: block.parentBeaconBlockRoot,
      requestsHash: block.requestsHash,
      blockAccessListHash: block.blockAccessListHash,
      slotNumber: block.slotNumber,
    },
    {
      common,
      // Only recompute the hash; don't enforce mainnet consensus rules such as
      // the 32-byte extraData limit, which PoA chains and devnets exceed.
      skipConsensusFormatValidation: true,
    },
  );
}

/**
 * Recompute keccak256(RLP(header)) from the block's fields and compare it with
 * the hash the node reported.
 *
 * @returns {{ valid: boolean, expected: string | null, actual: string, error?: string }}
 *   `expected` is the hash recomputed from the fields; `actual` is block.hash.
 *   If the fields are malformed or self-inconsistent (e.g. gasUsed > gasLimit)
 *   the header can't be rebuilt: `valid` is false, `expected` is null and
 *   `error` says why. Tampered data must be reported, never thrown.
 */
export function verifyHeaderHash(block) {
  const actual = String(block.hash).toLowerCase();
  let expected;
  try {
    expected = bytesToHex(headerFromRpcBlock(block).hash());
  } catch (err) {
    return { valid: false, expected: null, actual, error: err.message };
  }
  return { valid: expected === actual, expected, actual };
}
