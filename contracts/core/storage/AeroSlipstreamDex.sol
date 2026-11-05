// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract AeroSlipstreamDexStorage {
    mapping(address => mapping(address => int24)) internal _tickSpacing;
}
