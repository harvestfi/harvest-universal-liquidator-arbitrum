// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/**
 * Test-only stand-in for the ArbSys precompile at 0x64, which a Hardhat fork does not have.
 * The swap hook on the Slipstream-style pools (0xC0ed888AfE87ed1AcF01D9f19bB850159e3ce434) calls
 * arbBlockNumber() in beforeSwap. On a fork block.number is the L2 block number, which is what
 * arbBlockNumber() returns on Arbitrum. Anything else reverts so an unexpected call shows up.
 * Install with hardhat_setCode; never deploy.
 */
contract ArbSysStub {
    function arbBlockNumber() external view returns (uint256) {
        return block.number;
    }
}
