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
 * web3.eth.getBlock or a raw eth_getBlockByNumber call).
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
 * @returns {{ valid: boolean, expected: string, actual: string }}
 *   `expected` is the hash recomputed from the fields; `actual` is block.hash.
 */
export function verifyHeaderHash(block) {
  const expected = bytesToHex(headerFromRpcBlock(block).hash());
  const actual = String(block.hash).toLowerCase();
  return { valid: expected === actual, expected, actual };
}
