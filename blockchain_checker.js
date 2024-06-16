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

      // Check for genesis block (Block 0)
      if (i === 0 && block.parentHash === null) {
        // Handle genesis block scenario
        console.log(`Genesis Block ${i}:`);
        console.log(`Hash: ${block.hash}`);
        console.log(`-------------------`);
        previousBlockHash = block.hash; // Genesis block has no parentHash
        continue;
      }

      
      const expectedBlockHash = web3.utils.sha3(
        web3.eth.abi.encodeParameters(
          ['uint256', 'uint256', 'string', 'string', 'uint256'],
          [block.number, block.timestamp, block.parentHash, block.miner, block.nonce]
        )
      );

      // Compare expected hash with actual hash
      if (block.hash !== expectedBlockHash) {
        console.error(`Block ${i} hash does not match!`);
        console.error(`Expected hash: ${expectedBlockHash}`);
        console.error(`Actual hash: ${block.hash}`);
        console.error(`Block details:`);
        console.error(block);
        return;
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
