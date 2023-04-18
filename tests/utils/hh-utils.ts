import { impersonateAccount } from "@nomicfoundation/hardhat-network-helpers";

export async function impersonates(targetAccounts: string[]) {
  console.log("Impersonating...");
  for (let i = 0; i < targetAccounts.length; i++) {
    console.log(targetAccounts[i]);
    await impersonateAccount(targetAccounts[i]);
  }
}