import dexes from "../../helpers/dexes.json";
import feesPair from "../../helpers/fees.json";
import intermediateTokens from "../../helpers/intermediate-tokens.json";

import * as utils from "./hh-utils";
import * as types from "../types";

import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

export async function setupTokens(tokenPair: types.ITokenPair, faucet: SignerWithAddress) {
    // create instances
    const sellToken = await ethers.getContractAt("IERC20", tokenPair.sellToken.address);
    const buyToken = await ethers.getContractAt("IERC20", tokenPair.buyToken.address);

    // check if pairInfo has whale
    const whale = await async function (address: string | undefined) {
        if (address) {
            return await ethers.getSigner(address);
        } else {
            throw new Error("No whale address");
        }
    }(tokenPair.sellToken.whale);

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

export async function setupIntermediateTokens(governance: SignerWithAddress, registry: Contract) {
    const intermediateTokensList = intermediateTokens.test.map((token) => {
        return token.address;
    });
    await registry.connect(governance).setIntermediateToken(intermediateTokensList);
    intermediateTokensList.forEach(async (token, index) => {
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
        await setPath(governance, registry, tokenPair);
    }
}

export async function setupPools(governance: SignerWithAddress, deployedDexes: types.IDex[], poolIdsList: types.IPoolList[]) {
    poolIdsList.forEach(async (dex) => {
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
        dex.pools.forEach(async (poolId) => {
            await addNewPoolId(governance, dexContract, poolId);
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
    await dex.connect(governance).setPoolId(token1, token2, fee);
    expect(await dex.pairFee(token1, token2)).to.equal(fee);
    expect(await dex.pairFee(token2, token1)).to.equal(fee);
}

export async function setPath(governance: SignerWithAddress, registry: Contract, pairInfo: types.ITokenPair) {
    const path = pairInfo.paths;
    await registry.connect(governance).setPath(ethers.utils.formatBytes32String(pairInfo.dex), path);
    const resultPath = await registry.getPath(path[0], path[path.length - 1]);
    path.forEach(async (token, index) => {
        expect(resultPath[0].paths[index]).to.equal(token);
    });
}

export async function addNewPoolId(governance: SignerWithAddress, dex: Contract, poolInfo: types.IPool) {
    const path = poolInfo.poolIds;
    const sellToken = poolInfo.sellToken.address;
    const buyToken = poolInfo.buyToken.address;

    await dex.connect(governance).setPoolId(sellToken, buyToken, path);
    const resultPath = await dex.getPoolId(sellToken, buyToken);
    path.forEach(async (poolId, index) => {
        expect(resultPath[index]).to.equal(poolId);
    });
}