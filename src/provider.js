import 'dotenv/config';
import Web3 from 'web3';

export const providerUrl = process.env.WEB3_PROVIDER_URL || 'http://localhost:8545';

export const web3 = new Web3(providerUrl);
