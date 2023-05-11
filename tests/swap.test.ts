// Utilities
import addresses from "../helpers/addresses.json";
import pools from "../helpers/pools.json";
import tokenPairs from "../helpers/token-pairs.json";

import * as utils from "./utils";
import * as types from "./types";

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { BigNumber } from "ethers";

describe("Universal Liquidator: Swapping Tests", function () {
  async function setupAccounts() {
    const accounts = await ethers.getSigners();
    const testFarmer = accounts[1];

    // impersonate accounts
    await utils.impersonates([addresses.Governance]);
    const governance = await ethers.getSigner(addresses.Governance);

    await accounts[9].sendTransaction({
      to: governance.address,
      value: ethers.utils.parseEther("5") // 5 ether
    })
    await accounts[9].sendTransaction({
      to: testFarmer.address,
      value: ethers.utils.parseEther("5") // 5 ether
    })

    return { testFarmer, governance, faucet: accounts[9] };
  }

  async function preSwapSetup(tokenPair: types.ITokenPair, pathList: types.ITokenPair[], poolIdList: types.IPoolList[], sellAmount?: BigNumber, minBuyAmount?: BigNumber) {
    ////** Setup Accounts & Addresses *////
    const { testFarmer, governance, faucet } = await loadFixture(setupAccounts);
    // setup tokens
    const { sellToken, buyToken, whale } = await utils.setupTokens(tokenPair.sellToken.address, tokenPair.buyToken.address, tokenPair.sellToken.whale, faucet);

    ////** Setup System *////
    // deploy contracts
    const { registry, universalLiquidator, deployedDexes } = await utils.setupSystemBase(governance);
    // add dexes
    await utils.setupDexes(governance, registry, deployedDexes);
    // add intermediate tokens
    await utils.setupIntermediateTokens(governance, registry);
    // add token pairs
    await utils.setupPaths(governance, registry, pathList);
    // add fees
    await utils.setupFees(governance, deployedDexes);
    // add pools
    await utils.setupPools(governance, deployedDexes, poolIdList);

    // if no sellAmount or minBuyAmount is provided, set the values
    if (!sellAmount || !minBuyAmount) {
      sellAmount = (await sellToken.balanceOf(whale.address)).div(60);
      minBuyAmount = BigNumber.from(1);
    }

    await sellToken.connect(whale).transfer(testFarmer.address, sellAmount);
    const deployedDex = deployedDexes.find((dex) => dex?.name === tokenPair.dex);
    if (!deployedDex) {
      throw new Error(`Could not find dex with name ${tokenPair.dex}`);
    }
    expect(await sellToken.balanceOf(testFarmer.address)).to.equal(sellAmount);
    expect(await sellToken.balanceOf(universalLiquidator.address)).to.equal(0);
    expect(await sellToken.balanceOf(deployedDex.address)).to.equal(0);
    expect(await buyToken.balanceOf(testFarmer.address)).to.equal(0);
    expect(await buyToken.balanceOf(universalLiquidator.address)).to.equal(0);
    expect(await buyToken.balanceOf(deployedDex.address)).to.equal(0);

    return { sellToken, buyToken, sellAmount, minBuyAmount, testFarmer, universalLiquidator, deployedDex }
  }

  async function happyPathTest(tokenPair: types.ITokenPair, pathList: types.ITokenPair[], poolIdList: types.IPoolList[]) {
    const { sellToken, buyToken, sellAmount, minBuyAmount, testFarmer, universalLiquidator, deployedDex } = await preSwapSetup(tokenPair, pathList, poolIdList);

    // execute swap
    await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
    await universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);

    expect(await sellToken.balanceOf(testFarmer.address)).to.equal(0);
    expect(await sellToken.balanceOf(universalLiquidator.address)).to.equal(0);
    expect(await sellToken.balanceOf(deployedDex.address)).to.equal(0);
    expect(await buyToken.balanceOf(testFarmer.address)).to.gte(minBuyAmount);
    expect(await buyToken.balanceOf(universalLiquidator.address)).to.equal(0);
    expect(await buyToken.balanceOf(deployedDex.address)).to.equal(0);
  }

  describe("Go Through the Token Pair List", function () {
    const list = tokenPairs.list;
    for (const tokenPair of list) {
      it(`Happy Path: ${tokenPair.sellToken.name} to ${tokenPair.buyToken.name}`, async function () {
        await happyPathTest(tokenPair, tokenPairs.list, pools.list);
      });

      it(`Didn't Set Paths: ${tokenPair.sellToken.name} to ${tokenPair.buyToken.name}`, async function () {
        //// Setup Accounts & Addresses ////
        const { testFarmer, governance, faucet } = await loadFixture(setupAccounts);
        // setup tokens
        const { sellToken, buyToken, whale } = await utils.setupTokens(tokenPair.sellToken.address, tokenPair.buyToken.address, tokenPair.sellToken.whale, faucet);

        //// Setup System ////
        // deploy contracts
        const { universalLiquidator } = await utils.setupSystemBase(governance);

        const sellAmount = (await sellToken.balanceOf(whale.address)).div(50);
        const minBuyAmount = 1;
        const swapTxRes = universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
        await expect(swapTxRes).to.rejectedWith("PathsNotExist()");
      });

      it(`Didn't Approve Dexes: ${tokenPair.sellToken.name} to ${tokenPair.buyToken.name}`, async function () {
        const { sellToken, buyToken, sellAmount, minBuyAmount, testFarmer, universalLiquidator, deployedDex } = await preSwapSetup(tokenPair, tokenPairs.list, pools.list);

        const swapTxRes = universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
        await expect(swapTxRes).to.be.reverted;

        expect(await sellToken.balanceOf(testFarmer.address)).to.equal(sellAmount);
        expect(await sellToken.balanceOf(universalLiquidator.address)).to.equal(0);
        expect(await sellToken.balanceOf(deployedDex.address)).to.equal(0);
        expect(await buyToken.balanceOf(testFarmer.address)).to.equal(0);
        expect(await buyToken.balanceOf(universalLiquidator.address)).to.equal(0);
        expect(await buyToken.balanceOf(deployedDex.address)).to.equal(0);
      });
    }
  });

  describe("Go Through the Test Token Pair List with Single Swap", function () {
    const testTokenPairs = tokenPairs.test.find((category) => category?.category === "singleSwap")?.tokenPairs as types.ITokenPair[];
    if (testTokenPairs) {
      for (const tokenPair of testTokenPairs) {
        it(`Happy Path: ${tokenPair.sellToken.name} to ${tokenPair.buyToken.name}`, async function () {
          await happyPathTest(tokenPair, testTokenPairs, pools.test);
        });
        it(`minBuyAmount enforced: ${tokenPair.sellToken.name} to ${tokenPair.buyToken.name}`, async function () {
          // set the sellAmount to 1 and set the limit super high
          const { sellToken, buyToken, sellAmount, minBuyAmount, testFarmer, universalLiquidator, deployedDex } = await preSwapSetup(tokenPair, testTokenPairs, pools.test, BigNumber.from(1), ethers.constants.MaxInt256);
          // execute swap
          await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
          const swapTxRes = universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
          await expect(swapTxRes).to.be.reverted;

          expect(await sellToken.balanceOf(testFarmer.address)).to.equal(sellAmount);
          expect(await sellToken.balanceOf(universalLiquidator.address)).to.equal(0);
          expect(await sellToken.balanceOf(deployedDex.address)).to.equal(0);
          expect(await buyToken.balanceOf(testFarmer.address)).to.equal(0);
          expect(await buyToken.balanceOf(universalLiquidator.address)).to.equal(0);
          expect(await buyToken.balanceOf(deployedDex.address)).to.equal(0);
        });
      }
    } else {
      throw new Error(`Could not find category with name singleSwap`);
    }
  });

  describe("Go Through the Test Token Pair List with Multihop Swap", function () {
    const testTokenPairs = tokenPairs.test.find((category) => category?.category === "multiSwap")?.tokenPairs as types.ITokenPair[];
    if (testTokenPairs) {
      for (const tokenPair of testTokenPairs) {
        it(`Happy Path: ${tokenPair.sellToken.name} to ${tokenPair.buyToken.name}`, async function () {
          await happyPathTest(tokenPair, testTokenPairs, pools.test);
        });
        it(`minBuyAmount enforced: ${tokenPair.sellToken.name} to ${tokenPair.buyToken.name}`, async function () {
          // set the sellAmount to 1 and set the limit super high
          const { sellToken, buyToken, sellAmount, minBuyAmount, testFarmer, universalLiquidator, deployedDex } = await preSwapSetup(tokenPair, testTokenPairs, pools.test, BigNumber.from(1), ethers.constants.MaxInt256);
          // execute swap
          await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
          const swapTxRes = universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
          await expect(swapTxRes).to.be.reverted;

          expect(await sellToken.balanceOf(testFarmer.address)).to.equal(sellAmount);
          expect(await sellToken.balanceOf(universalLiquidator.address)).to.equal(0);
          expect(await sellToken.balanceOf(deployedDex.address)).to.equal(0);
          expect(await buyToken.balanceOf(testFarmer.address)).to.equal(0);
          expect(await buyToken.balanceOf(universalLiquidator.address)).to.equal(0);
          expect(await buyToken.balanceOf(deployedDex.address)).to.equal(0);
        });
      }
    } else {
      throw new Error(`Could not find category with name multiSwap`);
    }
  });

  describe("Go Through the Test Token Pair List with Cross Dex Swap", function () {
    const testTokenPairs = tokenPairs.test.find((category) => category?.category === "crossDexSwap")?.tokenPairs as types.ICrossDexTokenPair[];
    if (testTokenPairs) {
      for (const tokenPair of testTokenPairs) {
        it(`Happy Path: ${tokenPair.description}`, async function () {
          ////** Setup Accounts & Addresses *////
          const { testFarmer, governance, faucet } = await loadFixture(setupAccounts);
          // setup tokens
          const { sellToken, buyToken, whale } = await utils.setupTokens(tokenPair.sellToken.address, tokenPair.buyToken.address, tokenPair.sellToken.whale, faucet);
          //// Setup System ////
          // deploy contracts
          const { registry, universalLiquidator, deployedDexes } = await utils.setupSystemBase(governance);
          // add dexes
          await utils.setupDexes(governance, registry, deployedDexes);
          // add fees
          await utils.setupFees(governance, deployedDexes);
          // add pools
          await utils.setupPools(governance, deployedDexes, pools.test);
          // set up path in dex1
          await utils.setPath(governance, registry, tokenPair.dexes[0].name, tokenPair.dexes[0].paths);
          // set up path in dex2
          await utils.setPath(governance, registry, tokenPair.dexes[1].name, tokenPair.dexes[1].paths);
          // set up intermediate token
          await utils.setupIntermediateTokens(governance, registry, [tokenPair.intermediate]);

          const sellAmount = (await sellToken.balanceOf(whale.address)).div(60);
          const minBuyAmount = BigNumber.from(1);

          await sellToken.connect(whale).transfer(testFarmer.address, sellAmount);
          const deployedDex0 = deployedDexes.find((dex) => dex?.name === tokenPair.dexes[0].name);
          const deployedDex1 = deployedDexes.find((dex) => dex?.name === tokenPair.dexes[1].name);
          if (!deployedDex0 || !deployedDex1) {
            throw new Error(`Could not find dex with name ${tokenPair.dexes[0].name} or ${tokenPair.dexes[1].name}`);
          }
          expect(await sellToken.balanceOf(testFarmer.address)).to.equal(sellAmount);
          expect(await sellToken.balanceOf(universalLiquidator.address)).to.equal(0);
          expect(await sellToken.balanceOf(deployedDex0.address)).to.equal(0);
          expect(await sellToken.balanceOf(deployedDex1.address)).to.equal(0);
          expect(await buyToken.balanceOf(testFarmer.address)).to.equal(0);
          expect(await buyToken.balanceOf(universalLiquidator.address)).to.equal(0);
          expect(await buyToken.balanceOf(deployedDex0.address)).to.equal(0);
          expect(await sellToken.balanceOf(deployedDex1.address)).to.equal(0);

          // execute swap
          await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
          await universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);

          expect(await sellToken.balanceOf(testFarmer.address)).to.equal(0);
          expect(await sellToken.balanceOf(universalLiquidator.address)).to.equal(0);
          expect(await sellToken.balanceOf(deployedDex0.address)).to.equal(0);
          expect(await sellToken.balanceOf(deployedDex1.address)).to.equal(0);
          expect(await buyToken.balanceOf(testFarmer.address)).to.gte(minBuyAmount);
          expect(await buyToken.balanceOf(universalLiquidator.address)).to.equal(0);
          expect(await buyToken.balanceOf(deployedDex0.address)).to.equal(0);
          expect(await sellToken.balanceOf(deployedDex1.address)).to.equal(0);
        });
      }
    } else {
      throw new Error(`Could not find category with name crossDexSwap`);
    }
  });
});