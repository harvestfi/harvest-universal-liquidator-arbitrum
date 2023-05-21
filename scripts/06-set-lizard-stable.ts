import { ethers } from "hardhat";

import addresses from "../helpers/addresses.json";
import prompts from "prompts";

async function main() {
    const addrs = await ethers.getSigners();

    console.log("Deploying contracts with the account:", addrs[0].address);
    console.log("Account balance:", (await addrs[0].getBalance()).toString());

    const dexContract = await ethers.getContractAt(
        "LizardDex",
        addresses.LizardDexAddr
    );

    const { tokenA, tokenB, stable } = await prompts([{
        type: 'text',
        name: 'tokenA',
        message: 'TokenA address',
    },
    {
        type: 'text',
        name: 'tokenB',
        message: 'TokenB address',
    },
    {
        type: 'text',
        name: 'stable',
        message: 'Is stable pool? (Bool)',
    }]);

    await dexContract.setStable(tokenA, tokenB, stable);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});