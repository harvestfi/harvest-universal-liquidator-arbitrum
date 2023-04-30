import addresses from "../helpers/addresses.json";
import tokenPairs from "../helpers/token-pairs.json";

import * as utils from "./utils";

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Universal Liquidator Registry: Functionality Tests", function () {
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

    async function setupDexes() {

    }

    describe("Happy Path", function () {
        it("Set Path", async function () {
            ////** Setup Accounts & Addresses *////
            const { testFarmer, governance, faucet } = await loadFixture(setupAccounts);
            // deploy contracts
            const { registry, universalLiquidator, deployedDexes } = await utils.setupSystemBase(governance);
            // add pools
            await utils.setupPools(governance, deployedDexes);
            // add dexes
            const balancerDex = deployedDexes.find((dex) => dex?.name === "balancer");
            const uniV3Dex = deployedDexes.find((dex) => dex?.name === "uniV3");

            if (!balancerDex) throw new Error(`Could not find dex with name balancer`);
            if (!uniV3Dex) throw new Error(`Could not find dex with name uniV3`);

            await utils.setupDexes(governance, registry, deployedDexes);

            // set the path for BAL -> ARB, through BAL -> WETH -> ARB with Balancer
            const testTokenPair = tokenPairs.test[0];
            // setup tokens
            const { sellToken, buyToken, whale } = await utils.setupTokens(testTokenPair, faucet);

            await utils.setPath(governance, registry, testTokenPair);

            const path = await registry.getPath(testTokenPair.sellToken.address, testTokenPair.buyToken.address);
            expect(path[0].paths).to.be.eql(testTokenPair.paths);
            expect(path[0].dex).to.be.equal(balancerDex.address);

            const sellAmount = (await sellToken.balanceOf(whale.address)).div(100);
            const minBuyAmount = 1;
            await sellToken.connect(whale).transfer(testFarmer.address, sellAmount);
            // execute swap
            await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
            await universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
            const postSwapBalance = await buyToken.balanceOf(testFarmer.address);
            expect(postSwapBalance).to.be.gt(0);

            // set the path for ARB -> BAL, through ARB -> WETH -> USDT -> BAL with UniswapV3
            const mockTestTokenPair = tokenPairs.test[1];
            await utils.setPath(governance, registry, mockTestTokenPair);

            const mockPath = await registry.getPath(testTokenPair.sellToken.address, testTokenPair.buyToken.address);
            expect(mockPath[0].paths).to.be.eql(mockTestTokenPair.paths);
            expect(mockPath[0].dex).to.be.equal(uniV3Dex.address);

            await sellToken.connect(whale).transfer(testFarmer.address, sellAmount);
            // execute swap
            await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
            await universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
            const mockPostSwapBalance = await buyToken.balanceOf(testFarmer.address);
            expect(mockPostSwapBalance).to.be.gt(postSwapBalance);
        });
        it("Set IntermediateToken", async function () {
            ////** Setup Accounts & Addresses *////
            const { testFarmer, governance, faucet } = await loadFixture(setupAccounts);
            // deploy contracts
            const { registry, universalLiquidator, deployedDexes } = await utils.setupSystemBase(governance);
            // add pools
            await utils.setupPools(governance, deployedDexes);
            // add dexes
            const balancerDex = deployedDexes.find((dex) => dex?.name === "balancer");
            const uniV3Dex = deployedDexes.find((dex) => dex?.name === "uniV3");

            if (!balancerDex) throw new Error(`Could not find dex with name balancer`);
            if (!uniV3Dex) throw new Error(`Could not find dex with name uniV3`);

            await utils.setupDexes(governance, registry, deployedDexes);

            // set the path for wstETH -> USDC, through wstETH -> USDC with Balancer
            // set the path for USDC -> ARB, through USDC -> ARB with UniswapV3
            const testSwap1TokenPair = tokenPairs.test[4];
            const testSwap2TokenPair = tokenPairs.test[5];
            // setup tokens
            const { sellToken, whale } = await utils.setupTokens(testSwap1TokenPair, faucet);
            const { buyToken } = await utils.setupTokens(testSwap2TokenPair, faucet);

            await utils.setPath(governance, registry, testSwap1TokenPair);
            await utils.setPath(governance, registry, testSwap2TokenPair);
            // get the path for wstETH -> ARB
            const targetTokenPair = tokenPairs.test[6];
            const getPathRet = registry.getPath(targetTokenPair.sellToken.address, targetTokenPair.buyToken.address);
            await expect(getPathRet).to.be.rejectedWith("PathsNotExist()");

            // set intermediate token
            await utils.setupIntermediateTokens(governance, registry);
            const pathWithUSDT = await registry.getPath(targetTokenPair.sellToken.address, targetTokenPair.buyToken.address);
            expect(pathWithUSDT[0].paths).to.be.eql(testSwap1TokenPair.paths);
            expect(pathWithUSDT[0].dex).to.be.equal(balancerDex.address);
            expect(pathWithUSDT[1].paths).to.be.eql(testSwap2TokenPair.paths);
            expect(pathWithUSDT[1].dex).to.be.equal(uniV3Dex.address);

            // execute swap
            const sellAmount = (await sellToken.balanceOf(whale.address)).div(100);
            const minBuyAmount = 1;
            await sellToken.connect(whale).transfer(testFarmer.address, sellAmount);
            await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
            await universalLiquidator.connect(testFarmer).swap(targetTokenPair.sellToken.address, targetTokenPair.buyToken.address, sellAmount, minBuyAmount, testFarmer.address);

            const balanceAfterSwapWithUSDT = await buyToken.balanceOf(testFarmer.address);
            expect(balanceAfterSwapWithUSDT).to.be.gt(0);

            // set the path for wstETH -> WETH, through wstETH -> WETH with Balancer
            // set the path for WETH -> ARB, through WETH -> ARB with UniswapV3
            const testSwap3TokenPair = tokenPairs.test[2];
            const testSwap4TokenPair = tokenPairs.test[3];
            await utils.setPath(governance, registry, testSwap3TokenPair);
            await utils.setPath(governance, registry, testSwap4TokenPair);
            // get the path for wstETH -> ARB
            const pathWithWETH = await registry.getPath(targetTokenPair.sellToken.address, targetTokenPair.buyToken.address);
            expect(pathWithWETH[0].paths).to.be.eql(testSwap3TokenPair.paths);
            expect(pathWithWETH[0].dex).to.be.equal(balancerDex.address);
            expect(pathWithWETH[1].paths).to.be.eql(testSwap4TokenPair.paths);
            expect(pathWithWETH[1].dex).to.be.equal(uniV3Dex.address);

            await sellToken.connect(whale).transfer(testFarmer.address, sellAmount);
            await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
            await universalLiquidator.connect(testFarmer).swap(targetTokenPair.sellToken.address, targetTokenPair.buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
            const balanceAfterSwapWithWETH = await buyToken.balanceOf(testFarmer.address);
            expect(balanceAfterSwapWithWETH).to.be.gt(balanceAfterSwapWithUSDT);
        });
        it("Adding new dex", async function () {
            ////** Setup Accounts & Addresses *////
            const { governance } = await loadFixture(setupAccounts);
            // deploy contracts
            const { registry, deployedDexes } = await utils.setupSystemBase(governance);
            // add pools
            await utils.setupPools(governance, deployedDexes);

            // add dexes
            const balancerDex = deployedDexes.find((dex) => dex?.name === "balancer");
            const uniV3Dex = deployedDexes.find((dex) => dex?.name === "uniV3");

            if (!balancerDex) throw new Error(`Could not find dex with name balancer`);
            if (!uniV3Dex) throw new Error(`Could not find dex with name uniV3`);

            const addedDex = [
                ethers.utils.formatBytes32String(balancerDex.name),
                ethers.utils.formatBytes32String(uniV3Dex.name)
            ]

            await utils.addNewDex(governance, registry, balancerDex);
            (await registry.getAllDexes()).forEach((dex) => {
                expect(addedDex).to.include(dex);
            });
            await utils.addNewDex(governance, registry, uniV3Dex);
            (await registry.getAllDexes()).forEach((dex) => {
                expect(addedDex).to.include(dex);
            });
        });
        it("Changing dex address", async function () {
            ////** Setup Accounts & Addresses *////
            const { testFarmer, governance, faucet } = await loadFixture(setupAccounts);
            // deploy contracts
            const { registry, universalLiquidator, deployedDexes } = await utils.setupSystemBase(governance);
            // add pools
            await utils.setupPools(governance, deployedDexes);

            // add dexes
            const balancerDex = deployedDexes.find((dex) => dex?.name === "balancer");
            const uniV3Dex = deployedDexes.find((dex) => dex?.name === "uniV3");

            if (!balancerDex) throw new Error(`Could not find dex with name balancer`);
            if (!uniV3Dex) throw new Error(`Could not find dex with name uniV3`);

            const randomAddress = ethers.Wallet.createRandom().address;
            await utils.addNewDex(governance, registry, { name: balancerDex.name, address: randomAddress });
            // set the path for BAL -> ARB, through BAL -> WETH -> ARB with Balancer
            const testTokenPair = tokenPairs.test[0];
            // setup tokens
            const { sellToken, buyToken, whale } = await utils.setupTokens(testTokenPair, faucet);

            await utils.setPath(governance, registry, testTokenPair);
            const path = await registry.getPath(testTokenPair.sellToken.address, testTokenPair.buyToken.address);
            expect(path[0].paths).to.be.eql(testTokenPair.paths);
            expect(path[0].dex).to.be.equal(randomAddress);

            const sellAmount = (await sellToken.balanceOf(whale.address)).div(100);
            const minBuyAmount = 1;
            await sellToken.connect(whale).transfer(testFarmer.address, sellAmount);
            // execute swap
            await sellToken.connect(testFarmer).approve(universalLiquidator.address, sellAmount);
            const swapRet = universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
            await expect(swapRet).to.be.reverted;

            // change dex address
            await registry.connect(governance).changeDexAddress(ethers.utils.formatBytes32String(balancerDex.name), balancerDex.address);
            await universalLiquidator.connect(testFarmer).swap(sellToken.address, buyToken.address, sellAmount, minBuyAmount, testFarmer.address);
            expect(await buyToken.balanceOf(testFarmer.address)).to.be.gt(0);
        });
    });

    describe("Ownership", function () {
        it("Only owner can setPath", async function () {
            ////** Setup Accounts & Addresses *////
            const { testFarmer, governance } = await loadFixture(setupAccounts);
            // deploy contracts
            const { registry, deployedDexes } = await utils.setupSystemBase(governance);
            // add dexes
            const balancerDex = deployedDexes.find((dex) => dex?.name === "balancer");
            if (!balancerDex) throw new Error(`Could not find dex with name balancer`);
            await utils.addNewDex(governance, registry, balancerDex);

            const testTokenPair = tokenPairs.test[0];
            const setPathTx = registry.connect(testFarmer).setPath(ethers.utils.formatBytes32String(testTokenPair.dex), testTokenPair.paths);
            await expect(setPathTx).to.be.revertedWith("Ownable: caller is not the owner");
            await registry.connect(governance).setPath(ethers.utils.formatBytes32String(testTokenPair.dex), testTokenPair.paths);
        });
        it("Only owner can setIntermediateToken", async function () {
        });
        it("Only owner can changeDexAddress", async function () {
        });
    });

    describe("Depend on the Existence of Dex", function () {
        it("Should setPath only if the dex exist", async function () {
        });
        it("Should failed with addDex if the dex exist", async function () {
        });
        it("Should failed with changeDexAddress if the dex doesn't exist", async function () {
        });
    });
});