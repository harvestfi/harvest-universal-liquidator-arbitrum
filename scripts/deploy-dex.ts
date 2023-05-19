import { ethers } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import prompts from "prompts";

import address from "../helpers/addresses.json";

async function main() {
    const addrs = await ethers.getSigners();

    console.log("Deploying contracts with the account:", addrs[0].address);
    console.log("Account balance:", (await addrs[0].getBalance()).toString());

    const ULR = await ethers.getContractFactory("UniversalLiquidatorRegistry");
    const universalLiquidatorRegistry = ULR.attach(address.UniversalLiquidatorRegistryAddr);

    const { dex, name } = await prompts([{
        type: 'text',
        name: 'dex',
        message: 'Which dex do you want to deploy? (Ex: UniV3Dex, the contract name)',
    },
    {
        type: 'text',
        name: 'name',
        message: 'Which name do you want to represent the dex? (Ex: uniV3)',
    }]);

    const Dex = await ethers.getContractFactory(dex) as ContractFactory & { deploy: () => Promise<Contract> };
    if ('deploy' in Dex) {
        const deployedDex = await Dex.deploy();
        await deployedDex.deployed();
        console.log(`${dex} address:`, deployedDex.address);
        await universalLiquidatorRegistry.addDex(ethers.utils.formatBytes32String(name), deployedDex.address);
    } else {
        console.error('Dex contract factory does not have a deploy method.');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});