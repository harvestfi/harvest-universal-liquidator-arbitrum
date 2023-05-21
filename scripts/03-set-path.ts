import { ethers } from "hardhat";

import address from "../helpers/addresses.json";
import prompts from "prompts";

async function main() {
    const addrs = await ethers.getSigners();

    console.log("Deploying contracts with the account:", addrs[0].address);
    console.log("Account balance:", (await addrs[0].getBalance()).toString());

    const registry = await ethers.getContractAt(
        "UniversalLiquidatorRegistry",
        address.UniversalLiquidatorRegistryAddr
    );

    const { dex, path } = await prompts([{
        type: 'text',
        name: 'dex',
        message: 'Which dex is the path for?',
    },
    {
        type: 'list',
        name: 'path',
        message: 'Give the token addresses for the swap path.',
    }]);

    await registry.setPath(ethers.utils.keccak256(ethers.utils.toUtf8Bytes(dex)), path);
    console.log("Added path:", path);
    console.log("For dex:", ethers.utils.keccak256(ethers.utils.toUtf8Bytes(dex)));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});