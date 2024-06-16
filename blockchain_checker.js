const Web3 = require('web3');
const contract = require('@truffle/contract');
const SimpleStorageArtifact = require('./build/contracts/SimpleStorage.json');

const web3 = new Web3('http://localhost:8545');

const SimpleStorage = contract(SimpleStorageArtifact);
SimpleStorage.setProvider(web3.currentProvider);

async function main() {
  const accounts = await web3.eth.getAccounts();
  const instance = await SimpleStorage.deployed();

  await instance.setData(42, { from: accounts[0] });

  const data = await instance.getData();
  console.log(`Stored data: ${data}`);
}
main()
