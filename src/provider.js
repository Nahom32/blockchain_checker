import 'dotenv/config';
import Web3 from 'web3';
import { createClient, DEFAULT_URL } from './rpc.js';

export const providerUrl = process.env.WEB3_PROVIDER_URL || DEFAULT_URL;

// Reads go through the JSON-RPC client, which returns raw responses and
// retries rate limits with backoff. web3 is kept only for sending
// transactions (scripts/check-local-node.js).
const client = createClient(providerUrl);
export const web3 = new Web3(providerUrl);

/**
 * Fetch a block straight from JSON-RPC (eth_getBlockByNumber), without web3's
 * response formatting. web3 drops header fields it doesn't know about (e.g.
 * Prague's requestsHash), which would make hash verification fail, so use this
 * for anything that recomputes hashes.
 *
 * @param {number|bigint|string} blockNumber a number or a tag like 'latest'
 */
export function getRawBlock(blockNumber, fullTransactions = false) {
  return client.getBlock(blockNumber, fullTransactions);
}

/** Fetch a block by hash straight from JSON-RPC (eth_getBlockByHash). See getRawBlock. */
export function getRawBlockByHash(blockHash, fullTransactions = false) {
  return client.getBlockByHash(blockHash, fullTransactions);
}

/** The latest block number, as a bigint. */
export function getBlockNumber() {
  return client.getBlockNumber();
}

/** Send a raw JSON-RPC request through the configured provider. */
export function rawRequest(method, params = []) {
  return client.request(method, params);
}
