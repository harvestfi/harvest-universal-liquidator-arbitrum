// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "../libraries/DataTypes.sol";

interface IUniversalLiquidatorRegistry {
    function getPath(
        address _sellToken,
        address _buyToken
    ) external view returns (DataTypes.SwapInfo[] memory);

    function setPath(
        address _sellToken,
        address _buyToken,
        bytes32 _dex,
        address[] memory _paths
    ) external;
}
