// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract LizardDexStorage {
    address public router;
    mapping(address => mapping(address => bool)) public isFeeOnTransfer;
    mapping(address => mapping(address => bool)) public isStable;
}
