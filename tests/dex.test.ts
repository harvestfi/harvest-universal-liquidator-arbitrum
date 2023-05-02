import addresses from "../helpers/addresses.json";
import fees from "../helpers/fees.json";
import poolIds from "../helpers/poolIds.json";

import * as utils from "./utils";

import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("Dexes: Functionality Tests", function () {
    async function setupAccounts() {
        const accounts = await ethers.getSigners();
        // impersonate accounts
        await utils.impersonates([addresses.Governance]);
        const governance = await ethers.getSigner(addresses.Governance);

        await accounts[9].sendTransaction({
            to: governance.address,
            value: ethers.utils.parseEther("5") // 5 ether
        })

        return { governance };
    }
    describe("Uniswap", function () {
        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const UniswapDex = await ethers.getContractFactory("UniV3Dex", governance);
            const uniswapDex = await UniswapDex.deploy();
            await uniswapDex.deployed();

            const testFeeList = fees.list.find(dex => dex.name === "uniV3");
            const testFeePair = testFeeList?.pools[0];
            if (!testFeePair) throw new Error(`Could not find the pools`);
            const testSellToken = testFeePair.sellToken.address;
            const testBuyToken = testFeePair.buyToken.address;
            const testFee = testFeePair.fee;
            return { governance, uniswapDex, testSellToken, testBuyToken, testFee };
        }
        describe("Happy Path", function () {
            it("Set fee", async function () {
                const { governance, uniswapDex, testSellToken, testBuyToken, testFee } = await loadFixture(setupDex);
                await uniswapDex.connect(governance).setFee(testSellToken, testBuyToken, testFee);
                expect(await uniswapDex.pairFee(testBuyToken, testSellToken)).to.equal(500);
                expect(await uniswapDex.pairFee(testSellToken, testBuyToken)).to.equal(500);
            });
        });
        describe("Ownership", function () {
            it("Only owner can set fee", async function () {
                const { uniswapDex, testSellToken, testBuyToken, testFee } = await loadFixture(setupDex);
                const testSetFeeTx = uniswapDex.setFee(testSellToken, testBuyToken, testFee);
                expect(testSetFeeTx).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });
    describe("Balancer", function () {
        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const BalancerDex = await ethers.getContractFactory("BalancerDex", governance);
            const balancerDex = await BalancerDex.deploy();
            await balancerDex.deployed();

            const testPoolList = poolIds.test.find(dex => dex.name === "balancer");
            const testPoolPair = testPoolList?.pools[0];
            if (!testPoolPair) throw new Error(`Could not find the pools`);
            const testSellToken = testPoolPair.sellToken.address;
            const testBuyToken = testPoolPair.buyToken.address;
            const testPoolIds = testPoolPair.poolIds;
            return { governance, balancerDex, testSellToken, testBuyToken, testPoolIds };
        }
        describe("Happy Path", function () {
            it("Set poolId", async function () {
                const { governance, balancerDex, testSellToken, testBuyToken, testPoolIds } = await loadFixture(setupDex);
                await balancerDex.connect(governance).setPoolId(testSellToken, testBuyToken, testPoolIds);
                expect(await balancerDex.getPoolId(testBuyToken, testSellToken)).to.eql(testPoolIds);
            });
        });
        describe("Ownership", function () {
            it("Only owner can set poolId", async function () {
                const { balancerDex, testSellToken, testBuyToken, testPoolIds } = await loadFixture(setupDex);
                const testSetPoolIdTx = balancerDex.setPoolId(testSellToken, testBuyToken, testPoolIds);
                expect(testSetPoolIdTx).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });
});