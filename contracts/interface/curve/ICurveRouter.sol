// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

interface ICurveRouter {
    function exchange(
        address[11] calldata _route,
        uint256[5][5] calldata _swap_params,
        uint256 _amount,
        uint256 _expected,
        address[5] calldata _pools,
        address _receiver
    ) external payable returns (uint256);
}
