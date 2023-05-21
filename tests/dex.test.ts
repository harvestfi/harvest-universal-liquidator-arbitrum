import addresses from "../helpers/addresses.json";
import fees from "../helpers/fees.json";
import pools from "../helpers/pools.json";

import * as types from "./types";
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

            const testPoolList = pools.test.find(dex => dex.name === "balancer");
            const testPoolPair = testPoolList?.pools[0] as types.IPool;
            if (!testPoolPair) throw new Error(`Could not find the pools`);
            const testSellToken = testPoolPair.sellToken.address;
            const testBuyToken = testPoolPair.buyToken.address;
            const testPools = testPoolPair.pools;
            if (!testPools) throw new Error(`Could not find the pools`);
            return { governance, balancerDex, testSellToken, testBuyToken, testPools };
        }

        describe("Happy Path", function () {
            it("Set poolId", async function () {
                const { governance, balancerDex, testSellToken, testBuyToken, testPools } = await loadFixture(setupDex);
                await balancerDex.connect(governance).setPool(testSellToken, testBuyToken, testPools);
                expect(await balancerDex.pool(testBuyToken, testSellToken)).to.eql(testPools);
            });
        });

        describe("Ownership", function () {
            it("Only owner can set poolId", async function () {
                const { balancerDex, testSellToken, testBuyToken, testPools } = await loadFixture(setupDex);
                const testSetPoolTx = balancerDex.setPool(testSellToken, testBuyToken, testPools);
                expect(testSetPoolTx).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });

    describe("Camelot", function () {
        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const CamelotDex = await ethers.getContractFactory("CamelotDex", governance);
            const camelotDex = await CamelotDex.deploy();
            await camelotDex.deployed();

            return { governance, camelotDex };
        }

        describe("Happy Path", function () {
            it("Set poolId", async function () {
                const { governance, camelotDex } = await loadFixture(setupDex);
                await camelotDex.connect(governance).setReferrer(governance.address);
                expect(await camelotDex.referrer()).to.be.equal(governance.address);
            });
        });

        describe("Ownership", function () {
            it("Only owner can set poolId", async function () {
                const { camelotDex } = await loadFixture(setupDex);
                const testSetPoolTx = camelotDex.setReferrer(ethers.Wallet.createRandom().address);
                expect(testSetPoolTx).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });

    describe("Curve", function () {
        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const CurveDex = await ethers.getContractFactory("CurveDex", governance);
            const curveDex = await CurveDex.deploy();
            await curveDex.deployed();

            const testPoolList = pools.test.find(dex => dex.name === "curve");
            const testPoolPair = testPoolList?.pools[0] as types.IPool;
            if (!testPoolPair) throw new Error(`Could not find the pools`);
            const testSellToken = testPoolPair.sellToken.address;
            const testBuyToken = testPoolPair.buyToken.address;
            const testPools = testPoolPair.pools;
            if (!testPools) throw new Error(`Could not find the pools`);
            return { governance, curveDex, testSellToken, testBuyToken, testPools };
        }

        describe("Happy Path", function () {
            it("Set poolId", async function () {
                const { governance, curveDex, testSellToken, testBuyToken, testPools } = await loadFixture(setupDex);
                await curveDex.connect(governance).setPool(testSellToken, testBuyToken, testPools[0]);
                expect(await curveDex.pool(testBuyToken, testSellToken)).to.eql(testPools[0]);
            });
        });

        describe("Ownership", function () {
            it("Only owner can set poolId", async function () {
                const { curveDex, testSellToken, testBuyToken, testPools } = await loadFixture(setupDex);
                const testSetPoolTx = curveDex.setPool(testSellToken, testBuyToken, testPools[0]);
                expect(testSetPoolTx).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });

    describe("Lizard", function () {
        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const LizardDex = await ethers.getContractFactory("LizardDex", governance);
            const lizardDex = await LizardDex.deploy();
            await lizardDex.deployed();

            const testPoolList = pools.test.find(dex => dex.name === "lizard");
            const testPoolPair = testPoolList?.pools[0] as types.IPool;
            if (!testPoolPair) throw new Error(`Could not find the pools`);
            const testSellToken = testPoolPair.sellToken.address;
            const testBuyToken = testPoolPair.buyToken.address;
            const isStable = testPoolPair.stable;
            if (!isStable) throw new Error(`Could not find the stable status`);
            return { governance, lizardDex, testSellToken, testBuyToken, isStable };
        }

        describe("Happy Path", function () {
            it("Set poolId", async function () {
                const { governance, lizardDex, testSellToken, testBuyToken, isStable } = await loadFixture(setupDex);
                await lizardDex.connect(governance).setStableToken(testSellToken, testBuyToken, isStable);
                expect(await lizardDex.isStable(testBuyToken, testSellToken)).to.eql(isStable);
            });
        });

        describe("Ownership", function () {
            it("Only owner can set poolId", async function () {
                const { lizardDex, testSellToken, testBuyToken, isStable } = await loadFixture(setupDex);
                const testSetPoolTx = lizardDex.setStableToken(testSellToken, testBuyToken, isStable);
                expect(testSetPoolTx).to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });
});