import 'dotenv/config';
import Web3 from 'web3';

// Connect to Ganache
const web3 = new Web3(process.env.WEB3_PROVIDER_URL || 'http://localhost:8545');

async function verifyBlockchainIntegrity() {
  try {
    const latestBlockNumber = await web3.eth.getBlockNumber();
    console.log(`Latest Block Number: ${latestBlockNumber}`);

    let previousBlockHash = null;
    for (let i = 0; i <= latestBlockNumber; i++) {
      const block = await web3.eth.getBlock(i);

      
      if (i === 0) {
        if (block.parentHash === '0x0000000000000000000000000000000000000000000000000000000000000000') {
          console.log(`Genesis Block ${i} is valid:`);
          console.log(`Hash: ${block.hash}`);
          console.log(`-------------------`);
          previousBlockHash = block.hash; // Genesis block has no parentHash
        } else {
          console.error(`Genesis Block ${i} has an incorrect parent hash!`);
          return;
        }
        continue;
      }

      // Check parent hash consistency
      if (previousBlockHash && block.parentHash !== previousBlockHash) {
        console.error(`Block ${i} has been tampered with!`);
        console.error(`Expected parent hash: ${previousBlockHash}`);
        console.error(`Actual parent hash: ${block.parentHash}`);
        return;
      }

      console.log(`Block ${i} is valid.`);
      previousBlockHash = block.hash;
    }
  } catch (error) {
    console.error('Error verifying blockchain integrity:', error);
  }
}

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

    // Verify blockchain integrity after fetching the blocks
    await verifyBlockchainIntegrity();
  } catch (error) {
    console.error('Error fetching block information:', error);
  }
}

getBlockHashes();
