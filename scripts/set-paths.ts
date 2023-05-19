import { ethers } from "hardhat";

import address from "../helpers/addresses.json";
import tokenPairs from "../helpers/token-pairs.json";

async function main() {
    const addrs = await ethers.getSigners();

    console.log("Deploying contracts with the account:", addrs[0].address);
    console.log("Account balance:", (await addrs[0].getBalance()).toString());

    const ULR = await ethers.getContractFactory("UniversalLiquidatorRegistry");
    const registry = ULR.attach(address.UniversalLiquidatorRegistryAddr);
    for (const tokenPair of tokenPairs.list) {
        await registry.setPath(ethers.utils.formatBytes32String(tokenPair.dex), tokenPair.paths);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});