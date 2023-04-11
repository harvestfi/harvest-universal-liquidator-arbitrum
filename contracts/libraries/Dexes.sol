// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

library Dexes {
    bytes32 public constant uniDex = bytes32(uint256(keccak256("uni")));
    bytes32 public constant sushiDex = bytes32(uint256(keccak256("sushi")));
}
