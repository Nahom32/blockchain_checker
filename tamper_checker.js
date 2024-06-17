import 'dotenv/config';
import Web3 from 'web3';

// Connect to Ganache
const web3 = new Web3(process.env.WEB3_PROVIDER_URL || 'http://localhost:8545');

async function simulateTampering() {
  try {
    const latestBlockNumber = await web3.eth.getBlockNumber();
    console.log(`Latest Block Number: ${latestBlockNumber}`);

    // Fetch a block to simulate tampering (block number 1 for example)
    const blockNumberToTamper = 1;
    const block = await web3.eth.getBlock(blockNumberToTamper);

    if (!block) {
      console.error(`Block ${blockNumberToTamper} not found.`);
      return;
    }

    console.log(`Original Block ${blockNumberToTamper}:`);
    console.log(block);

    // Simulate tampering with the block by changing the miner address
    const tamperedBlock = { ...block, miner: '0x0000000000000000000000000000000000000000' };

    console.log(`Tampered Block ${blockNumberToTamper} (simulated):`);
    console.log(tamperedBlock);

    // Verify blockchain integrity (this should detect the simulated tampering)
    await verifyBlockchainIntegrity(tamperedBlock);
  } catch (error) {
    console.error('Error simulating tampering:', error);
  }
}

async function verifyBlockchainIntegrity(tamperedBlock) {
  try {
    const latestBlockNumber = await web3.eth.getBlockNumber();
    console.log(`Latest Block Number: ${latestBlockNumber}`);

    let previousBlockHash = null;
    for (let i = 0; i <= latestBlockNumber; i++) {
      // Fetch the block
      const block = await web3.eth.getBlock(i);

      // Use the tampered block data if it matches the block number we're tampering with
      const currentBlock = (tamperedBlock && i === tamperedBlock.number) ? tamperedBlock : block;

      // Log current block for troubleshooting
      console.log(`Current Block ${i}:`, currentBlock);

      // Ensure values are strings and handle missing values
      const blockNumber = currentBlock.number.toString();
      const timestamp = currentBlock.timestamp.toString();
      const difficulty = currentBlock.difficulty.toString();
      const gasLimit = currentBlock.gasLimit.toString();
      const gasUsed = currentBlock.gasUsed.toString();
      const nonce = currentBlock.nonce.toString();
      const baseFeePerGas = (currentBlock.baseFeePerGas ? currentBlock.baseFeePerGas.toString() : '0');
      const withdrawalsRoot = currentBlock.withdrawalsRoot || '0x0000000000000000000000000000000000000000000000000000000000000000';

      console.log(`Encoded Parameters for Block ${i}:`, {
        blockNumber,
        timestamp,
        difficulty,
        gasLimit,
        gasUsed,
        nonce,
        baseFeePerGas,
        withdrawalsRoot
      });

      // Recalculate the block hash using appropriate fields
      const blockData = web3.eth.abi.encodeParameters(
        [
          'uint256', 'uint256', 'bytes32', 'bytes32', 'address', 'bytes32', 'bytes32',
          'bytes32', 'bytes', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes32',
          'uint256', 'bytes32'
        ],
        [
          blockNumber, timestamp, currentBlock.parentHash, currentBlock.sha3Uncles,
          currentBlock.miner, currentBlock.stateRoot, currentBlock.transactionsRoot, currentBlock.receiptsRoot,
          currentBlock.logsBloom, difficulty, gasLimit, gasUsed,
          nonce, currentBlock.extraData, currentBlock.mixHash, baseFeePerGas,
          withdrawalsRoot
        ]
      );

      const recalculatedHash = web3.utils.keccak256(blockData);

      if (currentBlock.hash !== recalculatedHash) {
        console.error(`Block ${i} hash does not match!`);
        console.error(`Expected hash: ${recalculatedHash}`);
        console.error(`Actual hash: ${currentBlock.hash}`);
        return;
      }

      // Check parent hash consistency
      if (previousBlockHash && currentBlock.parentHash !== previousBlockHash) {
        console.error(`Block ${i} has been tampered with!`);
        console.error(`Expected parent hash: ${previousBlockHash}`);
        console.error(`Actual parent hash: ${currentBlock.parentHash}`);
        return;
      }

      console.log(`Block ${i} is valid.`);
      previousBlockHash = currentBlock.hash;
    }
  } catch (error) {
    console.error('Error verifying blockchain integrity:', error);
  }
}

simulateTampering();
