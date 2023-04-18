// Utilities
import addresses from "../helpers/addresses.json";
import tokenPairs from "../helpers/token-pairs.json";
import intermediateTokens from "../helpers/intermediate-tokens.json";
import * as utils from "./utils";

import { contracts } from "../build/typechain";

import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

describe("All System", function () {
  let accounts: SignerWithAddress[];

  // external accounts
  let testFarmer: SignerWithAddress;
  let governance: SignerWithAddress;
  let registry: contracts.core.UniversalLiquidatorRegistry;
  let universalLiquidator: contracts.core.UniversalLiquidator;

  before(async function () {
    accounts = await ethers.getSigners();
    testFarmer = accounts[1];

    // impersonate accounts
    await utils.impersonates([addresses.Governance]);
    governance = await ethers.getSigner(addresses.Governance);

    await accounts[9].sendTransaction({
      to: governance.address,
      value: ethers.utils.parseEther("5") // 5 ether
    })

    const contracts = await utils.setupSystem(governance);
    registry = contracts.registry;
    universalLiquidator = contracts.universalLiquidator;
  });

  describe("Happy path", function () {
    it("Add new intermediate token to ULRegistry", async function () {
      const list = intermediateTokens.list.map((token) => {
        return token.address;
      });
      await utils.updateIntermediateToken(list, registry, governance);
    });

    it("Add new path to ULRegistry", async function () {
      const list = tokenPairs.list;
      for (const tokenPair of list) {
        await utils.addPaths(tokenPair, registry, governance);
      }
    });

    it("Swapping Test Token", async function () {
      const list = tokenPairs.list;
      for (const tokenPair of list) {
        await utils.swapTest(testFarmer, tokenPair, universalLiquidator, accounts[9]);
      }
    });
  });
});