import { ethers } from "hardhat";

import intermediateTokens from "../helpers/intermediate-tokens.json";

async function main() {
    const addrs = await ethers.getSigners();

    console.log("Deploying contracts with the account:", addrs[0].address);
    console.log("Account balance:", (await addrs[0].getBalance()).toString());

    const ULR = await ethers.getContractFactory("UniversalLiquidatorRegistry");
    const registry = await ULR.deploy();
    await registry.deployed();
    console.log("ULR address:", registry.address);

    const UL = await ethers.getContractFactory("UniversalLiquidator");
    const universalLiquidator = await UL.deploy();
    await universalLiquidator.deployed();
    await universalLiquidator.setPathRegistry(registry.address);
    console.log("UL address:", universalLiquidator.address);

    await registry.setIntermediateToken(intermediateTokens.list);
    console.log("Added intermediate tokens:", intermediateTokens.list);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});