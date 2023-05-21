import { ethers } from "hardhat";

import addresses from "../helpers/addresses.json";
import dexes from "../helpers/dexes.json";
import fees from "../helpers/fees.json";

async function main() {
    const addrs = await ethers.getSigners();

    console.log("Deploying contracts with the account:", addrs[0].address);
    console.log("Account balance:", (await addrs[0].getBalance()).toString());

    fees.list.forEach(async (dex) => {
        const dexName = dex.name;
        const dexFile = dexes.list.find((dex) => dex?.name === dexName);
        const dexAddrKey = `${dexFile?.file}Addr`;
        const dexAddr = (addresses as { [key: string]: string })[dexAddrKey];
        console.log(`${dexFile?.file} Address: `, dexAddr);

        if (!dexFile) {
            throw new Error(`Could not find contract file with name ${dexName}`);
        }

        const dexContract = await ethers.getContractAt(dexFile.file, dexAddr);
        dex.pools.forEach(async (feePair) => {
            await dexContract.setFee(feePair.sellToken.address, feePair.buyToken.address, feePair.fee);
        });
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});