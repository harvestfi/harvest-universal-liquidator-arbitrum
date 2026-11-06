// Swaps through the AeroSlipstreamDex on an Arbitrum fork, compared with the meta quoter on the real chain.
//
// The pools' swap hook (0xC0ed888AfE87ed1AcF01D9f19bB850159e3ce434) uses TLOAD/TSTORE, which this
// repo's Hardhat (2.13.1) cannot execute, and calls the ArbSys precompile at 0x64, which no fork has.
// So this file needs a Cancun fork node (anvil) and installs ArbSysStub at 0x64; on the in-process
// Hardhat network it skips itself. See "Slipstream fork tests" in the README.

import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { BigNumber, Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

const ARBSYS = "0x0000000000000000000000000000000000000064";
const ROUTER = "0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418";
const META_QUOTER = "0x1dDfeC5058180C207F55BB77D95AcDd0d8227868";

const USDG = "0x004B506865409877C9fA29bfb1ebA929984B9bbC";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const IFARM = "0x9dCA587dc65AC0a043828B0acd946d71eb8D46c1";
// USDG keeps balances in a mapping at slot 1
const USDG_BALANCE_SLOT = 1;

const POOL_USDG_USDC = "0x09328BE718d89228A985471bb470988a34d0B162"; // tick spacing 1
const POOL_USDC_WETH = "0x30c83aaECC7ceAbea96b881a62729A1DF366eFd5"; // tick spacing 100
const POOL_USDG_WETH = "0x14CecB8A37013853Ad071FC877705a8EcC9e77B7"; // tick spacing 100

const TICK_SPACINGS: [string, string, number][] = [
    [USDG, USDC, 1],
    [USDC, WETH, 100],
    [USDG, WETH, 100],
];

const ROUTES = [
    { name: "USDG > USDC > WETH", path: [USDG, USDC, WETH], pools: [POOL_USDG_USDC, POOL_USDC_WETH] },
    { name: "WETH > USDC > USDG", path: [WETH, USDC, USDG], pools: [POOL_USDC_WETH, POOL_USDG_USDC] },
    { name: "USDG > WETH", path: [USDG, WETH], pools: [POOL_USDG_WETH] },
    { name: "WETH > USDG", path: [WETH, USDG], pools: [POOL_USDG_WETH] },
];
const SIZES_USD = [10, 1000, 50000];
// ethers' estimate is not enough on anvil: with exactly the estimated gas the swap reverts, with any
// headroom it goes through, so every swap gets an explicit limit
const GAS = { gasLimit: 5_000_000 };

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function transfer(address,uint256) returns (bool)",
    "function deposit() payable",
];
const META_QUOTER_ABI = [
    "function quoteExactInput(address[] pools, address tokenIn, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList)",
];
const ROUTER_ABI = [
    "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256)",
    "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

const dexId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("aeroSlipstream"));
const camelotId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("camelot"));

describe("AeroSlipstream: fork swaps against the real pools", function () {
    let farmer: SignerWithAddress;
    let registry: Contract;
    let universalLiquidator: Contract;
    let slipstreamDex: Contract;
    let camelotDex: Contract;
    let forkBlock: number;
    let forkTimestamp: number;
    let chain: ethers.providers.JsonRpcProvider;
    let wethPerUsd: BigNumber; // WETH wei per 1 USD, from the real chain at the fork block
    const rows: string[] = [];

    const send = (method: string, params: any[]) => ethers.provider.send(method, params);
    // ethers' wait() can hang on anvil's Arbitrum fork: receipts carry an L1-style blockNumber, and
    // after an evm_revert it waits for a block that automine never produces. Poll the receipt instead.
    const mined = async (tx: Promise<any>) => {
        const { hash } = await tx;
        for (let i = 0; i < 600; i++) {
            const receipt = await send("eth_getTransactionReceipt", [hash]);
            if (receipt) {
                if (receipt.status !== "0x1") throw new Error(`transaction ${hash} reverted`);
                return receipt;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`transaction ${hash} not mined`);
    };
    const deploy = async (name: string) => {
        const contract = await (await ethers.getContractFactory(name, farmer)).deploy();
        await mined(Promise.resolve(contract.deployTransaction));
        return contract;
    };
    const token = (address: string) => new ethers.Contract(address, ERC20_ABI, farmer);
    const tickSpacingOf = (a: string, b: string) =>
        TICK_SPACINGS.find(([x, y]) => (x === a && y === b) || (x === b && y === a))![2];

    async function quoteOnChain(pools: string[], tokenIn: string, amountIn: BigNumber): Promise<BigNumber> {
        const quoter = new ethers.Contract(META_QUOTER, META_QUOTER_ABI, chain);
        const res = await quoter.callStatic.quoteExactInput(pools, tokenIn, amountIn, { blockTag: forkBlock });
        return res.amountOut;
    }

    async function fund(address: string, sellToken: string, amount: BigNumber) {
        if (sellToken === USDG) {
            const slot = ethers.utils.solidityKeccak256(["uint256", "uint256"], [address, USDG_BALANCE_SLOT]);
            await send("hardhat_setStorageAt", [USDG, ethers.utils.hexStripZeros(slot), ethers.utils.hexZeroPad(amount.toHexString(), 32)]);
        } else if (sellToken === WETH) {
            await mined(token(WETH).deposit({ value: amount }));
        } else {
            throw new Error(`no faucet for ${sellToken}`);
        }
        expect(await token(sellToken).balanceOf(address)).to.equal(amount);
    }

    async function sizeIn(sellToken: string, usd: number): Promise<BigNumber> {
        if (sellToken === USDG) return ethers.utils.parseUnits(String(usd), 6);
        return wethPerUsd.mul(usd);
    }

    async function balancesOf(tokens: string[], holders: string[]) {
        return Promise.all(holders.map((h) => Promise.all(tokens.map((t) => token(t).balanceOf(h)))));
    }

    before(async function () {
        const client: string = await send("web3_clientVersion", []);
        if (client.toLowerCase().startsWith("hardhatnetwork")) {
            console.log("      skipped: the Slipstream hook needs Cancun opcodes; run against anvil (see README)");
            this.skip();
        }
        expect(await send("eth_chainId", [])).to.equal("0xa4b1");

        const info = await send("anvil_nodeInfo", []);
        forkBlock = Number(process.env.FORK_BLOCK ?? info.forkConfig.forkBlockNumber);
        forkTimestamp = (await ethers.provider.getBlock(forkBlock)).timestamp;
        chain = new ethers.providers.JsonRpcProvider(
            process.env.QUOTE_RPC_URL ?? `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMEY_KEY}`
        );

        // without this every swap on these pools dies with an invalid opcode at 0x64
        const stub = await artifacts.readArtifact("ArbSysStub");
        await send("hardhat_setCode", [ARBSYS, stub.deployedBytecode]);

        [farmer] = await ethers.getSigners();
        await send("hardhat_setBalance", [farmer.address, ethers.utils.parseEther("1000000").toHexString()]);

        registry = await deploy("UniversalLiquidatorRegistry");
        universalLiquidator = await deploy("UniversalLiquidator");
        await mined(universalLiquidator.setPathRegistry(registry.address));
        await mined(registry.setIntermediateToken([WETH, "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", USDC, "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"]));

        slipstreamDex = await deploy("AeroSlipstreamDex");
        await mined(registry.addDex(dexId, slipstreamDex.address));
        for (const [a, b, spacing] of TICK_SPACINGS) {
            await mined(slipstreamDex.setTickSpacing(a, b, spacing));
        }
        camelotDex = await deploy("CamelotDex");
        await mined(registry.addDex(camelotId, camelotDex.address));

        // price WETH off the real USDC/WETH pool: WETH wei for 1 USDC
        const usdcPerWeth = await quoteOnChain([POOL_USDC_WETH], WETH, ethers.utils.parseEther("1"));
        wethPerUsd = ethers.utils.parseEther("1").mul(1e6).div(usdcPerWeth);
    });

    let snapshot: string;
    beforeEach(async function () {
        snapshot = await send("evm_snapshot", []);
        // the hook's fee decays with time since the fork block; anvil stamps blocks with wall-clock
        // time, so pull the clock back to the fork block for every case to match the chain's quote
        await send("anvil_setTime", [forkTimestamp]);
    });
    afterEach(async function () {
        await send("evm_revert", [snapshot]);
    });
    after(function () {
        if (rows.length) console.log(["", "      route                   usd      amountIn                 fork out                 chain quote", ...rows].join("\n"));
    });

    for (const route of ROUTES) {
        for (const usd of SIZES_USD) {
            it(`${route.name}, $${usd}: matches the meta quoter and leaves nothing behind`, async function () {
                const sellToken = route.path[0];
                const buyToken = route.path[route.path.length - 1];
                const amountIn = await sizeIn(sellToken, usd);
                await mined(registry.setPath(dexId, route.path));
                await fund(farmer.address, sellToken, amountIn);

                const holders = [universalLiquidator.address, slipstreamDex.address, ROUTER];
                const before = await balancesOf(route.path, holders);
                const buyBefore = await token(buyToken).balanceOf(farmer.address);

                await mined(token(sellToken).approve(universalLiquidator.address, amountIn));
                await mined(universalLiquidator.connect(farmer).swap(sellToken, buyToken, amountIn, 1, farmer.address, GAS));

                const out = (await token(buyToken).balanceOf(farmer.address)).sub(buyBefore);
                const quote = await quoteOnChain(route.pools, sellToken, amountIn);
                rows.push(`      ${route.name.padEnd(22)} ${String(usd).padStart(6)}  ${amountIn.toString().padEnd(24)} ${out.toString().padEnd(24)} ${quote.toString()}`);

                expect(await token(sellToken).balanceOf(farmer.address)).to.equal(0);
                expect(out).to.equal(quote);
                // UL, adapter and router hold exactly what they held before, for every token on the path
                expect(await balancesOf(route.path, holders)).to.deep.equal(before);
            });
        }
    }

    it("multi-hop output equals the router's own exactInput with an int24-encoded path (the Base adapter's call)", async function () {
        for (const route of ROUTES.filter((r) => r.path.length === 3)) {
            const outer = await send("evm_snapshot", []);
            const sellToken = route.path[0];
            const buyToken = route.path[2];
            const amountIn = await sizeIn(sellToken, 1000);
            await fund(farmer.address, sellToken, amountIn);
            const inner = await send("evm_snapshot", []);

            await mined(registry.setPath(dexId, route.path));
            await mined(token(sellToken).approve(universalLiquidator.address, amountIn));
            const b0 = await token(buyToken).balanceOf(farmer.address);
            await mined(universalLiquidator.connect(farmer).swap(sellToken, buyToken, amountIn, 1, farmer.address, GAS));
            const viaAdapter = (await token(buyToken).balanceOf(farmer.address)).sub(b0);

            await send("evm_revert", [inner]);
            const encoded = ethers.utils.solidityPack(
                ["address", "int24", "address", "int24", "address"],
                [route.path[0], tickSpacingOf(route.path[0], route.path[1]), route.path[1], tickSpacingOf(route.path[1], route.path[2]), route.path[2]]
            );
            const router = new ethers.Contract(ROUTER, ROUTER_ABI, farmer);
            await mined(token(sellToken).approve(ROUTER, amountIn));
            const b1 = await token(buyToken).balanceOf(farmer.address);
            await mined(router.exactInput({ path: encoded, recipient: farmer.address, deadline: ethers.constants.MaxUint256, amountIn, amountOutMinimum: 1 }, GAS));
            const viaRouter = (await token(buyToken).balanceOf(farmer.address)).sub(b1);

            expect(viaAdapter).to.equal(viaRouter);
            await send("evm_revert", [outer]);
        }
    });

    it("USDG > iFARM composes aeroSlipstream USDG > WETH with camelot WETH > iFARM", async function () {
        const amountIn = await sizeIn(USDG, 1000);
        await mined(registry.setPath(dexId, [USDG, WETH]));
        await mined(registry.setPath(camelotId, [WETH, IFARM]));
        await fund(farmer.address, USDG, amountIn);
        await mined(token(USDG).approve(universalLiquidator.address, amountIn));

        await mined(universalLiquidator.connect(farmer).swap(USDG, IFARM, amountIn, 1, farmer.address, GAS));

        expect(await token(IFARM).balanceOf(farmer.address)).to.be.gt(0);
        for (const t of [USDG, WETH, IFARM]) {
            expect(await token(t).balanceOf(slipstreamDex.address)).to.equal(0);
            expect(await token(t).balanceOf(camelotDex.address)).to.equal(0);
            expect(await token(t).balanceOf(universalLiquidator.address)).to.equal(0);
        }
    });
});
