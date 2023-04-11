// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "@openzeppelin/contracts/access/Ownable.sol";

import {ULRegistryStorage} from "./storage/Storage.sol";

import "../interface/IUniversalLiquidatorRegistry.sol";

import "../libraries/DataTypes.sol";

contract UniversalLiquidatorRegistry is
    Ownable,
    IUniversalLiquidatorRegistry,
    ULRegistryStorage
{
    constructor() public {}

    function getPath(
        address _sellToken,
        address _buyToken
    ) public view override returns (DataTypes.SwapInfo[] memory) {
        if (paths[_sellToken][_buyToken].dex != bytes32(0)) {
            DataTypes.SwapInfo[] memory retPaths = new DataTypes.SwapInfo[](1);
            retPaths[0] = DataTypes.SwapInfo(
                dexesInfo[paths[_sellToken][_buyToken].dex],
                paths[_sellToken][_buyToken].paths
            );
            return retPaths;
        }

        for (uint256 i = 0; i < intermediateTokens.length; i++) {
            if (
                paths[_sellToken][intermediateTokens[i]].dex != bytes32(0) &&
                paths[intermediateTokens[i]][_buyToken].dex != bytes32(0)
            ) {
                // found the intermediateToken and intermediateDex
                DataTypes.SwapInfo[] memory retPaths = new DataTypes.SwapInfo[](
                    2
                );
                retPaths[0] = DataTypes.SwapInfo(
                    dexesInfo[paths[_sellToken][intermediateTokens[i]].dex],
                    paths[_sellToken][intermediateTokens[i]].paths
                );
                retPaths[1] = DataTypes.SwapInfo(
                    dexesInfo[paths[intermediateTokens[i]][_buyToken].dex],
                    paths[intermediateTokens[i]][_buyToken].paths
                );
                return retPaths;
            }
        }
        revert("Liquidation path is not set");
    }

    function setPath(
        address _sellToken,
        address _buyToken,
        bytes32 _dex,
        address[] memory _paths
    ) external override onlyOwner {
        // path could also be an empty array
        require(
            _sellToken == _paths[0],
            "The first token of the Uniswap route must be the from token"
        );
        require(
            _buyToken == _paths[_paths.length - 1],
            "The last token of the Uniswap route must be the to token"
        );

        // path can also be empty
        paths[_sellToken][_buyToken] = DataTypes.PathInfo(_dex, _paths);
    }
}
