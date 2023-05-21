// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/uniswap/v2/IUniswapV2Router02.sol";
import "../../interface/uniswap/v2/IUniswapV2Factory.sol";

// constants and types
import {BaseDexStorage} from "../storage/BaseDex.sol";

contract UniBasedDex is Ownable, ILiquidityDex, BaseDexStorage {
    using SafeERC20 for IERC20;

    constructor(address _initRouter) {
        _router = _initRouter;
    }

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeIncreaseAllowance(_router, _sellAmount);

        uint256[] memory returned = IUniswapV2Router02(_router)
            .swapExactTokensForTokens(
                _sellAmount,
                _minBuyAmount,
                _path,
                _receiver,
                block.timestamp
            );

        return returned[returned.length - 1];
    }

    function router() public view returns (address) {
        return _router;
    }

    receive() external payable {}
}
