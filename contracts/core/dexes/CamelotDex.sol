// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/camelot/ICamelotRouter.sol";

// constants and types
import {BaseDexStorage} from "../storage/BaseDex.sol";

contract CamelotDex is Ownable, ILiquidityDex, BaseDexStorage {
    using SafeERC20 for IERC20;

    constructor(address _router) {
        router = _router;
    }

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) public override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeIncreaseAllowance(router, _sellAmount);

        ICamelotRouter(router)
            .swapExactTokensForTokensSupportingFeeOnTransferTokens(
                _sellAmount,
                _minBuyAmount,
                _path,
                _receiver,
                address(0),
                block.timestamp
            );
    }
}
