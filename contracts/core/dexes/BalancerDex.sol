// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/balancer/IBVault.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {BalancerDexStorage} from "../storage/BalancerDex.sol";

import "hardhat/console.sol";

contract BalancerDex is Ownable, ILiquidityDex, BalancerDexStorage {
    using SafeERC20 for IERC20;

    function setPoolId(
        address _token0,
        address _token1,
        bytes32[] memory _poolId
    ) external onlyOwner {
        poolIds[_token0][_token1] = _poolId;
        poolIds[_token1][_token0] = _poolId;
    }

    function getPoolId(
        address _token0,
        address _token1
    ) external view onlyOwner returns (bytes32[] memory) {
        return poolIds[_token0][_token1];
    }

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) public override returns (uint256) {
        console.log(_sellAmount);
        console.log(_minBuyAmount);

        address sellToken = _path[0];
        address buyToken = _path[_path.length - 1];

        console.log(IERC20(sellToken).balanceOf(address(this)));
        console.log(IERC20(buyToken).balanceOf(address(this)));

        bytes32[] memory poolId = poolIds[sellToken][buyToken];

        IBVault.BatchSwapStep[] memory swaps = new IBVault.BatchSwapStep[](
            _path.length - 1
        );

        swaps[0].amount = _sellAmount;
        for (uint256 idx; idx < _path.length - 1; ) {
            swaps[idx].poolId = poolId[idx];
            swaps[idx].assetInIndex = idx;
            swaps[idx].assetOutIndex = idx + 1;

            unchecked {
                ++idx;
            }
        }

        IAsset[] memory assets = new IAsset[](_path.length);
        for (uint256 i = 0; i < _path.length; i++) {
            assets[i] = IAsset(_path[i]);
        }

        IBVault.FundManagement memory funds;
        funds.sender = address(this);
        funds.recipient = payable(_receiver);

        int256[] memory limits = new int256[](_path.length);
        limits[0] = int256(_sellAmount);
        limits[_path.length - 1] = -int256(_minBuyAmount);

        IERC20(sellToken).safeIncreaseAllowance(
            Addresses.balancerVault,
            _sellAmount
        );

        //return
        uint256(
            IBVault(Addresses.balancerVault).batchSwap(
                IBVault.SwapKind.GIVEN_IN,
                swaps,
                assets,
                funds,
                limits,
                block.timestamp
            )[0]
        );

        console.log(IERC20(sellToken).balanceOf(address(this)));
        console.log(IERC20(sellToken).balanceOf(_receiver));
        console.log(IERC20(buyToken).balanceOf(address(this)));
        console.log(IERC20(buyToken).balanceOf(_receiver));
    }

    receive() external payable {}
}
