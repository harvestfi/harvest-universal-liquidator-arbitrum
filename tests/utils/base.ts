import dexes from "../../helpers/dexes.json";
import feesPair from "../../helpers/fees.json";
import intermediateTokens from "../../helpers/intermediate-tokens.json";

import * as utils from "./hh-utils";
import * as types from "../types";

import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

export async function setupTokens(token0Addr: string, token1Addr: string, token0Whale: string | undefined, faucet: SignerWithAddress) {
    // create instances
    const sellToken = await ethers.getContractAt("IERC20", token0Addr);
    const buyToken = await ethers.getContractAt("IERC20", token1Addr);

    // check if pairInfo has whale
    const whale = await async function (address: string | undefined) {
        if (address) {
            return await ethers.getSigner(address);
        } else {
            throw new Error("No whale address");
        }
    }(token0Whale);

    await utils.impersonates([whale.address]);

    // setup balance
    await faucet.sendTransaction({
        to: whale.address,
        value: ethers.utils.parseEther("5") // 5 ether
    })

    return { sellToken, buyToken, whale };
}

export async function setupSystemBase(governance: SignerWithAddress) {
    const ULR = await ethers.getContractFactory("UniversalLiquidatorRegistry");
    const registry = await ULR.deploy();
    await registry.transferOwnership(governance.address);

    const UL = await ethers.getContractFactory("UniversalLiquidator");
    const universalLiquidator = await UL.deploy();
    await universalLiquidator.setPathRegistry(registry.address);
    await universalLiquidator.transferOwnership(governance.address);

    const deployedDexes = await deployDexes(governance);

    return { registry, universalLiquidator, deployedDexes };
}

export async function setupDexes(governance: SignerWithAddress, registry: Contract, dexes: types.IDex[]) {
    dexes.forEach(async (dex: types.IDex) => {
        await addNewDex(governance, registry, dex);
    });
}

export async function setupIntermediateTokens(governance: SignerWithAddress, registry: Contract, intermediateTokensList?: string[]) {
    if (intermediateTokensList === undefined) {
        intermediateTokensList = intermediateTokens.test.map((token) => {
            return token.address;
        });
    }

    await registry.connect(governance).setIntermediateToken(intermediateTokensList);
    intermediateTokensList?.forEach(async (token, index) => {
        expect(await registry.intermediateTokens(index)).to.equal(token);
    });
}

export async function setupFees(governance: SignerWithAddress, deployedDexes: types.IDex[]) {
    feesPair.list.forEach(async (dex) => {
        const dexName = dex.name;
        const deployedDex = deployedDexes.find((dex) => dex?.name === dexName);
        const dexFile = dexes.list.find((dex) => dex?.name === dexName);
        if (!deployedDex) {
            throw new Error(`Could not find dex with name ${dexName}`);
        }
        if (!dexFile) {
            throw new Error(`Could not find contract file with name ${dexName}`);
        }
        const dexContract = await ethers.getContractAt(dexFile.file, deployedDex.address);
        dex.pools.forEach(async (feePair) => {
            await setFee(governance, dexContract, feePair);
        });
    });
}

export async function setupPaths(governance: SignerWithAddress, registry: Contract, tokenPairList: types.ITokenPair[]) {
    for (const tokenPair of tokenPairList) {
        await setPath(governance, registry, tokenPair.dex, tokenPair.paths);
    }
}

export async function setupPools(governance: SignerWithAddress, deployedDexes: types.IDex[], poolsList: types.IPoolList[]) {
    poolsList.forEach(async (dex) => {
        const dexName = dex.name;
        const deployedDex = deployedDexes.find((dex) => dex?.name === dexName);
        const dexFile = dexes.list.find((dex) => dex?.name === dexName);
        if (!deployedDex) {
            throw new Error(`Could not find dex with name ${dexName}`);
        }
        if (!dexFile) {
            throw new Error(`Could not find contract file with name ${dexName}`);
        }
        const dexContract = await ethers.getContractAt(dexFile.file, deployedDex.address);
        dex.pools.forEach(async (pool) => {
            await addNewPool(governance, dexContract, pool, dexName);
        });
    });
}

async function deployDexes(governance: SignerWithAddress) {
    const result = [];
    const dexesList = dexes.list;
    for (const dex of dexesList) {
        const Dex = await ethers.getContractFactory(dex.file);
        const deployedDex = await Dex.deploy();
        await deployedDex.transferOwnership(governance.address);
        result.push({
            name: dex.name, address: deployedDex.address
        } as types.IDex);
    }
    return result
}

export async function addNewDex(governance: SignerWithAddress, registry: Contract, dex: types.IDex) {
    const hexName = ethers.utils.formatBytes32String(dex.name);
    await registry.connect(governance).addDex(hexName, dex.address);
    expect(await registry.dexesInfo(hexName)).to.equal(dex.address);
}

export async function setFee(governance: SignerWithAddress, dex: Contract, feeInfo: types.IFeePair) {
    const token1 = feeInfo.sellToken.address;
    const token2 = feeInfo.buyToken.address;
    const fee = feeInfo.fee;
    await dex.connect(governance).setFee(token1, token2, fee);
    expect(await dex.pairFee(token1, token2)).to.equal(fee);
    expect(await dex.pairFee(token2, token1)).to.equal(fee);
}

export async function setPath(governance: SignerWithAddress, registry: Contract, dex: string, path: string[]) {
    await registry.connect(governance).setPath(ethers.utils.formatBytes32String(dex), path);
    const resultPath = await registry.getPath(path[0], path[path.length - 1]);
    path.forEach(async (token, index) => {
        expect(resultPath[0].paths[index]).to.equal(token);
    });
}

export async function addNewPool(governance: SignerWithAddress, dex: Contract, poolInfo: types.IPool, type: string) {
    if (type === "balancer") {
        const path = poolInfo.pools;
        const sellToken = poolInfo.sellToken.address;
        const buyToken = poolInfo.buyToken.address;
        await dex.connect(governance).setPool(sellToken, buyToken, path);
        const resultPath = await dex.getPool(sellToken, buyToken);
        path?.forEach(async (poolId, index) => {
            expect(resultPath[index]).to.equal(poolId);
        });
    } else if (type === "curve") {
        const path = poolInfo.pools ?? [];
        const sellToken = poolInfo.sellToken.address;
        const buyToken = poolInfo.buyToken.address;
        await dex.connect(governance).setPool(sellToken, buyToken, path[0]);
        const resultPath = await dex.getPool(sellToken, buyToken);
        path?.forEach(async (poolId, index) => {
            expect(resultPath[index]).to.equal(poolId);
        });
    } else if (type === "lizard") {
        const sellToken = poolInfo.sellToken.address;
        const buyToken = poolInfo.buyToken.address;
        await dex.connect(governance).setStableToken(sellToken, buyToken, poolInfo.stable);
        expect(await dex.isStable(sellToken, buyToken)).to.be.true;
    }
}