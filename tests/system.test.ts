// Utilities
import addresses from "../helpers/addresses.json";
import dex from "../helpers/dexes.json";
import poolIds from "../helpers/poolIds.json";
import tokenPairs from "../helpers/token-pairs.json";
import intermediateTokens from "../helpers/intermediate-tokens.json";
import * as utils from "./utils";

import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("All System", function () {
  async function deploySetup() {
    const accounts = await ethers.getSigners();
    const testFarmer = accounts[1];

    // impersonate accounts
    await utils.impersonates([addresses.Governance]);
    const governance = await ethers.getSigner(addresses.Governance);

    await accounts[9].sendTransaction({
      to: governance.address,
      value: ethers.utils.parseEther("5") // 5 ether
    })

    // deploy contracts
    const contracts = await utils.setupSystem(governance);
    const registry = contracts.registry;
    const universalLiquidator = contracts.universalLiquidator;
    const deployedDexes = contracts.deployedDexes;

    // add intermediate tokens
    const intermediateTokensList = intermediateTokens.list.map((token) => {
      return token.address;
    });
    await utils.updateIntermediateToken(intermediateTokensList, registry, governance);

    // add pools
    poolIds.list.forEach(async (poolIds) => {
      const dexName = poolIds.name;
      const deployedDex = deployedDexes.find((dex) => dex?.name === dexName);
      const dexFile = dex.list.find((dex) => dex?.name === dexName);
      if (!deployedDex) {
        throw new Error(`Could not find dex with name ${dexName}`);
      }
      if (!dexFile) {
        throw new Error(`Could not find contract file with name ${dexName}`);
      }
      const dexContract = await ethers.getContractAt(dexFile.file, deployedDex.address);
      poolIds.pools.forEach(async (poolId) => {
        await utils.addPoolIds(poolId, dexContract, governance);
      });
    });

    // add token pairs
    const tokenPairList = tokenPairs.list;
    for (const tokenPair of tokenPairList) {
      await utils.addPaths(tokenPair, registry, governance);
    }

    return { testFarmer, universalLiquidator, faucet: accounts[9] };
  }

  describe("Happy Path", function () {
    const list = tokenPairs.list;
    for (const tokenPair of list) {
      it("Swapping Test Token", async function () {
        const { testFarmer, universalLiquidator, faucet } = await loadFixture(deploySetup);
        console.log(universalLiquidator.address);
        await utils.swapTest(testFarmer, tokenPair, universalLiquidator, faucet);
      });
    }
  });
});