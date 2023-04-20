import "hardhat-gas-reporter"
import "solidity-coverage";
import "@nomicfoundation/hardhat-toolbox"
import { config as dotenvConfig } from "dotenv"
import { HardhatUserConfig } from "hardhat/config"
import { NetworksUserConfig } from "hardhat/types"
import { resolve } from "path"
import { config } from "./package.json"

dotenvConfig({ path: resolve(__dirname, "./.env") })

function getNetworks(): NetworksUserConfig {
  if (!process.env.ALCHEMEY_KEY)
    throw new Error(
      `ALCHEMEY_KEY env var not set. Copy .env.template to .env and set the env var`
    )

  const alchemyApiKey = process.env.ALCHEMEY_KEY;
  const accounts = process.env.MNEMONIC ? { mnemonic: process.env.MNEMONIC } : [];

  return {
    hardhat: {
      accounts: accounts,
      forking: {
        url: `https://arb-mainnet.g.alchemy.com/v2/${alchemyApiKey}`,
        // blockNumber: 82350734, // <-- edit here
      },
    },
    mainnet: {
      url: `https://arb-mainnet.g.alchemy.com/v2/${alchemyApiKey}`,
      accounts: accounts,
    },
  }
}

const hardhatConfig: HardhatUserConfig = {
  solidity: config.solidity,
  paths: {
    sources: config.paths.contracts,
    tests: config.paths.tests,
    cache: config.paths.cache,
    artifacts: config.paths.build.contracts,
  },
  networks: {
    ...getNetworks(),
  },
  typechain: {
    outDir: config.paths.build.typechain,
    target: "ethers-v5",
  },
  etherscan: {
    apiKey: {
      mainnet: `${process.env.ARBISCAN_API_KEY}`
    },
  },
  gasReporter: {
    enabled: (process.env.REPORT_GAS) ? true : false
  },
  mocha: {
    timeout: 1200 * 1e3,
  },
}

export default hardhatConfig