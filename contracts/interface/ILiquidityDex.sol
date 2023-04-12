// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

interface ILiquidityDex {
    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _liquidator,
        address _receiver,
        address[] memory _path
    ) external returns (uint256);
}
