import dexes from "../../helpers/dexes.json";

import * as utils from "./index";
import * as types from "../types";

import { contracts } from "../../build/typechain";
import { openzeppelin } from "../../build/typechain";

import { expect, util } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

export async function setupSystem(governance: SignerWithAddress) {
    console.log("Setting up whole system");

    console.log("Deploying UL Registry");
    const ULR = await ethers.getContractFactory("UniversalLiquidatorRegistry");
    const registry = await ULR.deploy();
    console.log("UL Registry deployed at:", registry.address);
    await registry.transferOwnership(governance.address);

    console.log("Deploying UL");
    const UL = await ethers.getContractFactory("UniversalLiquidator");
    const universalLiquidator = await UL.deploy();
    console.log("UL deployed at:", universalLiquidator.address);
    await universalLiquidator.setPathRegistry(registry.address);
    await universalLiquidator.transferOwnership(governance.address);

    const deployedDexes = await deployDexes(governance);
    deployedDexes.forEach(async (dex: types.IDex) => {
        await addNexDexes(governance, registry, dex);
    });

    return { registry, universalLiquidator } as const;
}

export async function deployDexes(governance: SignerWithAddress) {
    console.log("Deploying Dex");
    const result = [];
    const dexesList = dexes.list;
    for (const dex of dexesList) {
        const Dex = await ethers.getContractFactory(dex.file);
        const deployedDex = await Dex.deploy();
        console.log(`Dex ${dex.name} deployed at:`, deployedDex.address);
        await deployedDex.transferOwnership(governance.address);
        result.push({
            name: dex.name, address: deployedDex.address
        } as types.IDex);
    }
    return result
}

export async function addNexDexes(governance: SignerWithAddress, registry: contracts.core.UniversalLiquidatorRegistry, dex: types.IDex) {
    console.log("Adding Dex");
    const hexName = ethers.utils.formatBytes32String(dex.name);
    await registry.connect(governance).addDex(hexName, dex.address);
    console.log("Add Dex with name:", hexName);
    expect(await registry.dexesInfo(hexName)).to.equal(dex.address);
}

export async function updateIntermediateToken(token: string[], registry: contracts.core.UniversalLiquidatorRegistry, governance: SignerWithAddress) {
    const intermediateTokens = token;
    await registry.connect(governance).setIntermediateToken(intermediateTokens);
    console.log("Add intermediate tokens: ", intermediateTokens);
    intermediateTokens.forEach(async (token, index) => {
        expect(await registry.intermediateTokens(index)).to.equal(token);
    });
}

export async function addPaths(pariInfo: types.ITokenPair, registry: contracts.core.UniversalLiquidatorRegistry, governance: SignerWithAddress) {
    const path = pariInfo.paths;
    await registry.connect(governance).setPath(ethers.utils.formatBytes32String(pariInfo.dex), path);
    console.log("Add path: ", path);
    const resultPath = await registry.getPath(path[0], path[path.length - 1]);
    path.forEach(async (token, index) => {
        expect(resultPath[0].paths[index]).to.equal(token);
    });
}

export async function swapTest(farmer: SignerWithAddress, pariInfo: types.ITokenPair, universalLiquidator: contracts.core.UniversalLiquidator, faucet: SignerWithAddress) {
    // create instances
    let sellToken: openzeppelin.contracts.token.erc20.IERC20
    let buyToken: openzeppelin.contracts.token.erc20.IERC20;
    let whale: SignerWithAddress;

    sellToken = await ethers.getContractAt("IERC20", pariInfo.sellToken.address);
    buyToken = await ethers.getContractAt("IERC20", pariInfo.buyToken.address);

    whale = await ethers.getSigner(pariInfo.sellToken.whale);
    await utils.impersonates([whale.address]);

    // setup balance
    await faucet.sendTransaction({
        to: whale.address,
        value: ethers.utils.parseEther("5") // 5 ether
    })
    await faucet.sendTransaction({
        to: farmer.address,
        value: ethers.utils.parseEther("5") // 5 ether
    })
    const balance = await sellToken.balanceOf(whale.address);
    await sellToken.connect(whale).transfer(farmer.address, balance);

    // execute swap
    expect(await buyToken.balanceOf(farmer.address)).to.equal(0);
    await sellToken.connect(farmer).approve(universalLiquidator.address, balance);
    await universalLiquidator.connect(farmer).swap(sellToken.address, buyToken.address, balance, 1, farmer.address);
    expect(await sellToken.balanceOf(farmer.address)).to.equal(0);
    expect(await buyToken.balanceOf(farmer.address)).to.gt(0);
}