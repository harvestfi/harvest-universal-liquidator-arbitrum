import { ethers } from "hardhat";

import addresses from "../helpers/addresses.json";
import dexes from "../helpers/dexes.json";
import pools from "../helpers/pools.json";

import * as types from "../tests/types";

async function main() {
    const addrs = await ethers.getSigners();

    console.log("Deploying contracts with the account:", addrs[0].address);
    console.log("Account balance:", (await addrs[0].getBalance()).toString());

    pools.list.forEach(async (dex) => {
        const dexName = dex.name;
        const dexFile = dexes.list.find((dex) => dex?.name === dexName);
        const dexAddrKey = `${dexFile?.file}Addr`;
        const dexAddr = (addresses as { [key: string]: string })[dexAddrKey];
        console.log(`${dexFile?.file} Address: `, dexAddr);

        if (!dexFile) {
            throw new Error(`Could not find contract file with name ${dexName}`);
        }

        const dexContract = await ethers.getContractAt(dexFile.file, dexAddr);
        dex.pools.forEach(async (pool: types.IPool) => {
            if (dexName === "balancer") {
                const path = pool.pools;
                const sellToken = pool.sellToken.address;
                const buyToken = pool.buyToken.address;
                await dexContract.setPool(sellToken, buyToken, path);
            } else if (dexName === "curve") {
                const path = pool.pools ?? [];
                const sellToken = pool.sellToken.address;
                const buyToken = pool.buyToken.address;
                await dexContract.setPool(sellToken, buyToken, path[0]);
            } else if (dexName === "lizard") {
                const sellToken = pool.sellToken.address;
                const buyToken = pool.buyToken.address;
                await dexContract.setStableToken(sellToken, buyToken, pool.stable);
            }
        });
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});