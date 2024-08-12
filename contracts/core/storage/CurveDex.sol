// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

abstract contract CurveDexStorage {
    mapping(address => mapping(address => address)) internal _pool;
    mapping(address => mapping(address => uint256[5])) internal _params;
}
