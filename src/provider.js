import 'dotenv/config';
import Web3 from 'web3';

export const providerUrl = process.env.WEB3_PROVIDER_URL || 'http://localhost:8545';

export const web3 = new Web3(providerUrl);

/**
 * Fetch a block straight from JSON-RPC (eth_getBlockByNumber), without web3's
 * response formatting. web3 drops header fields it doesn't know about (e.g.
 * Prague's requestsHash), which would make hash verification fail, so use this
 * for anything that recomputes hashes.
 *
 * @param {number|bigint|string} blockNumber a number or a tag like 'latest'
 */
export async function getRawBlock(blockNumber, fullTransactions = false) {
  const tag = typeof blockNumber === 'string' ? blockNumber : `0x${BigInt(blockNumber).toString(16)}`;
  return web3.requestManager.send({
    method: 'eth_getBlockByNumber',
    params: [tag, fullTransactions],
  });
}

/** Fetch a block by hash straight from JSON-RPC (eth_getBlockByHash). See getRawBlock. */
export async function getRawBlockByHash(blockHash, fullTransactions = false) {
  return web3.requestManager.send({
    method: 'eth_getBlockByHash',
    params: [blockHash, fullTransactions],
  });
}

/** Send a raw JSON-RPC request through the configured provider. */
export function rawRequest(method, params = []) {
  return web3.requestManager.send({ method, params });
}
