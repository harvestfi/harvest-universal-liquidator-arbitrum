import { impersonateAccount } from "@nomicfoundation/hardhat-network-helpers";

export async function impersonates(targetAccounts: string[]) {
  for (let i = 0; i < targetAccounts.length; i++) {
    await impersonateAccount(targetAccounts[i]);
  }
}