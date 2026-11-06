import addresses from "../helpers/addresses.json";
import fees from "../helpers/fees.json";
import pools from "../helpers/pools.json";

import * as types from "./types";
import * as utils from "./utils";

import { artifacts, ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture, setCode } from "@nomicfoundation/hardhat-network-helpers";

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

    describe("AeroSlipstream", function () {
        const ROUTER = "0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418";
        const USDG = "0x004B506865409877C9fA29bfb1ebA929984B9bbC";
        const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

        async function setupDex() {
            const { governance } = await loadFixture(setupAccounts);
            const AeroSlipstreamDex = await ethers.getContractFactory("AeroSlipstreamDex", governance);
            const slipstreamDex = await AeroSlipstreamDex.deploy();
            await slipstreamDex.deployed();
            return { governance, slipstreamDex };
        }

        // the real pools cannot be swapped on this Hardhat (see tests/slipstream.test.ts), so these
        // run against a mock router that under-fills odd amounts, installed at the router's address
        async function setupMockRouter() {
            const { governance, slipstreamDex } = await loadFixture(setupDex);
            const mock = await artifacts.readArtifact("MockSlipstreamRouter");
            await setCode(ROUTER, mock.deployedBytecode);
            const TestToken = await ethers.getContractFactory("TestToken", governance);
            const tokens = [];
            for (const symbol of ["A", "B", "C"]) {
                const t = await TestToken.deploy(symbol);
                await t.deployed();
                await t.transfer(ROUTER, ethers.utils.parseEther("1000"));
                tokens.push(t);
            }
            const [a, b, c] = tokens;
            await slipstreamDex.connect(governance).setTickSpacing(a.address, b.address, 1);
            await slipstreamDex.connect(governance).setTickSpacing(b.address, c.address, 100);
            return { governance, slipstreamDex, a, b, c };
        }

        describe("Happy Path", function () {
            it("Set tick spacing", async function () {
                const { governance, slipstreamDex } = await loadFixture(setupDex);
                await slipstreamDex.connect(governance).setTickSpacing(USDG, USDC, 1);
                expect(await slipstreamDex.tickSpacing(USDG, USDC)).to.equal(1);
                expect(await slipstreamDex.tickSpacing(USDC, USDG)).to.equal(1);
            });

            it("Swaps hop by hop, applying the minimum output to the last hop only", async function () {
                const { governance, slipstreamDex, a, b, c } = await loadFixture(setupMockRouter);
                await a.transfer(slipstreamDex.address, 1001);
                const receiver = ethers.Wallet.createRandom().address;
                // 1001 A -> 1008 B -> 1015 C; the B hop pays 1008, below the minimum of 1015
                await slipstreamDex.connect(governance).doSwap(1001, 1015, receiver, [a.address, b.address, c.address]);
                expect(await c.balanceOf(receiver)).to.equal(1015);
                for (const t of [a, b, c]) expect(await t.balanceOf(slipstreamDex.address)).to.equal(0);
                expect(await a.allowance(slipstreamDex.address, ROUTER)).to.equal(0);
                expect(await b.allowance(slipstreamDex.address, ROUTER)).to.equal(0);
            });
        });

        describe("Failure Path", function () {
            it("Reverts for a pair without a tick spacing", async function () {
                const { slipstreamDex } = await loadFixture(setupDex);
                await expect(slipstreamDex.doSwap(1000, 1, USDG, [USDG, USDC]))
                    .to.be.revertedWithCustomError(slipstreamDex, "TickSpacingNotSet").withArgs(USDG, USDC);
            });

            it("Reverts with PartialFill when the first hop leaves input behind", async function () {
                const { slipstreamDex, a, b } = await loadFixture(setupMockRouter);
                await a.transfer(slipstreamDex.address, 1007);
                await expect(slipstreamDex.doSwap(1007, 1, USDG, [a.address, b.address]))
                    .to.be.revertedWithCustomError(slipstreamDex, "PartialFill").withArgs(a.address, 503, 1007);
            });

            it("Reverts with PartialFill when an intermediate hop leaves input behind", async function () {
                const { slipstreamDex, a, b, c } = await loadFixture(setupMockRouter);
                await a.transfer(slipstreamDex.address, 1000);
                // 1000 A fills and pays 1007 B, which the next hop only half takes
                await expect(slipstreamDex.doSwap(1000, 1, USDG, [a.address, b.address, c.address]))
                    .to.be.revertedWithCustomError(slipstreamDex, "PartialFill").withArgs(b.address, 503, 1007);
            });

            it("Reverts when the last hop pays less than the minimum", async function () {
                const { slipstreamDex, a, b, c } = await loadFixture(setupMockRouter);
                await a.transfer(slipstreamDex.address, 1001);
                await expect(slipstreamDex.doSwap(1001, 1016, USDG, [a.address, b.address, c.address]))
                    .to.be.revertedWith("Too little received");
            });
        });

        describe("Ownership", function () {
            it("Only owner can set tick spacing", async function () {
                const { slipstreamDex } = await loadFixture(setupDex);
                const [, stranger] = await ethers.getSigners();
                await expect(slipstreamDex.connect(stranger).setTickSpacing(USDG, USDC, 1))
                    .to.be.revertedWith("Ownable: caller is not the owner");
            });
        });
    });
});
