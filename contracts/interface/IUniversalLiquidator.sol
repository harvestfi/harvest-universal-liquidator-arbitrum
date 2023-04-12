// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

interface IUniversalLiquidator {
    event Swap(
        address indexed buyToken,
        address indexed sellToken,
        address indexed receiver,
        address initiator,
        uint256 sellAmount,
        uint256 minBuyAmount
    );

    function swapTokenOnMultipleDEXes(
        address _sellToken,
        address _buyToken,
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver
    ) external returns (uint256);
}
