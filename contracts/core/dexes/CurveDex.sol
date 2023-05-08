// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/curve/ICurveRegistryExchange.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {CurveDexStorage} from "../storage/CurveDex.sol";

contract CurveDex is Ownable, ILiquidityDex, CurveDexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) public override returns (uint256) {
        uint256 sellAmount = _sellAmount;
        uint256 minBuyAmount;
        address receiver;

        for (uint256 idx; idx < _path.length - 1; ) {
            if (idx != _path.length - 2) {
                minBuyAmount = 1;
                receiver = address(this);
            } else {
                minBuyAmount = _minBuyAmount;
                receiver = _receiver;
            }

            address sellToken = _path[idx];
            address buyToken = _path[idx + 1];
            IERC20(sellToken).safeIncreaseAllowance(
                Addresses.curveRouter,
                sellAmount
            );

            ICurveRegistryExchange(Addresses.curveRouter).exchange(
                _pool[sellToken][buyToken],
                sellToken,
                buyToken,
                sellAmount,
                minBuyAmount,
                receiver
            );

            sellAmount = IERC20(buyToken).balanceOf(address(this));
            unchecked {
                ++idx;
            }
        }
    }

    function setPool(
        address _poolAddr,
        address _token0,
        address _token1
    ) public onlyOwner {
        _pool[_token0][_token1] = _poolAddr;
        _pool[_token1][_token0] = _poolAddr;
    }

    function getPool(
        address _token0,
        address _token1
    ) public view returns (address) {
        return _pool[_token0][_token1];
    }
}
