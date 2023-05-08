// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/lizard/ILizardRouter01.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {LizardDexStorage} from "../storage/LizardDex.sol";

import "hardhat/console.sol";

contract LizardDex is Ownable, ILiquidityDex, LizardDexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) public override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeIncreaseAllowance(
            Addresses.lizardRouter,
            _sellAmount
        );

        ILizardRouter01.Route[] memory routes = new ILizardRouter01.Route[](
            _path.length - 1
        );

        for (uint256 idx; idx < _path.length - 1; ) {
            address curSellToken = _path[idx];
            address curBuyToken = _path[idx + 1];

            routes[idx].from = curSellToken;
            routes[idx].to = curBuyToken;
            routes[idx].stable = isStable[curSellToken][curBuyToken];

            unchecked {
                ++idx;
            }
        }

        if (!isFeeOnTransfer[_path[0]][_path[_path.length - 1]]) {
            ILizardRouter01(Addresses.lizardRouter).swapExactTokensForTokens(
                _sellAmount,
                _minBuyAmount,
                routes,
                _receiver,
                block.timestamp
            );
        } else {
            ILizardRouter01(Addresses.lizardRouter)
                .swapExactTokensForTokensSupportingFeeOnTransferTokens(
                    _sellAmount,
                    _minBuyAmount,
                    routes,
                    _receiver,
                    block.timestamp
                );
        }
    }

    function setTokenWithFeeOnTransfer(
        address _token0,
        address _token1,
        bool _isFeeOnTransfer
    ) external onlyOwner {
        isFeeOnTransfer[_token0][_token1] = _isFeeOnTransfer;
        isFeeOnTransfer[_token1][_token0] = _isFeeOnTransfer;
    }

    function setStableToken(
        address _token0,
        address _token1,
        bool _isStable
    ) external onlyOwner {
        isStable[_token0][_token1] = _isStable;
        isStable[_token1][_token0] = _isStable;
    }
}
