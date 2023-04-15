// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../../libraries/DataTypes.sol";

abstract contract UniswapV3DexStorage {
    mapping(address => mapping(address => uint24)) internal _pairFee;
}
