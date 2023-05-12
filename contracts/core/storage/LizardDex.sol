// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract LizardDexStorage {
    mapping(address => mapping(address => bool)) public isStable;
}
