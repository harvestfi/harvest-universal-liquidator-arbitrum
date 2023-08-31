// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract BalancerDexStorage {
    mapping(address => mapping(address => bytes32)) internal _poolIds;
}
