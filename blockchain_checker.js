import 'dotenv/config'; // This will load environment variables from .env file
import Web3 from 'web3';

// Verify Web3 is imported correctly
console.log('Web3:', Web3);

if (!Web3) {
  throw new Error('Web3 is not imported correctly.');
}

// Connect to Ganache
const web3 = new Web3(process.env.WEB3_PROVIDER_URL || 'http://localhost:8545');

async function getBlockHashes() {
  try {
    const latestBlockNumber = await web3.eth.getBlockNumber();
    console.log(`Latest Block Number: ${latestBlockNumber}`);

    for (let i = 0; i <= latestBlockNumber; i++) {
      const block = await web3.eth.getBlock(i);
      console.log(`Block ${i}:`);
      console.log(`Hash: ${block.hash}`);
      console.log(`Parent Hash: ${block.parentHash}`);
      console.log(`-------------------`);
    }
  } catch (error) {
    console.error('Error fetching block information:', error);
  }
}

getBlockHashes();
