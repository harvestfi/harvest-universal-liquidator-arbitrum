require("@nomiclabs/hardhat-etherscan");
require("@nomiclabs/hardhat-truffle5");
require("@nomiclabs/hardhat-ethers");

const keys = require("./dev-keys.json");
/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      accounts: {
        mnemonic: keys.mnemonic,
      },
      forking: {
        chainId: 42161,
        url: `https://arb-mainnet.g.alchemy.com/v2/${keys.alchemyKey}`,
        // blockNumber: 15087700, // <-- edit here
      },
    },
    mainnet: {
      url: `https://arb-mainnet.g.alchemy.com/v2/${keys.alchemyKey}`,
      accounts: {
        mnemonic: keys.mnemonic,
      },
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.6.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ],
  },
  mocha: {
    timeout: 2000000,
  },
  etherscan: {
    apiKey: keys.arbiscanAPI,
  },
};
