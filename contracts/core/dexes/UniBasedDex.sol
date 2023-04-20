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

contract UniBasedDex is ILiquidityDex, Ownable {
    using SafeERC20 for IERC20;

    receive() external payable {}

    address private uniswapRouter;
    address private uniswapFactory;

    constructor(address routerAddress, address factoryAddress) {
        uniswapRouter = routerAddress;
        uniswapFactory = factoryAddress;
    }

    function doSwap(
        uint256 amountIn,
        uint256 minAmountOut,
        address target,
        address[] memory path
    ) public override returns (uint256) {
        address buyToken = path[path.length - 1];
        address sellToken = path[0];

        require(
            buyToken == path[path.length - 1],
            "The last token on the path should be the buytoken"
        );
        IERC20(sellToken).safeIncreaseAllowance(uniswapRouter, amountIn);

        uint256[] memory returned = IUniswapV2Router02(uniswapRouter)
            .swapExactTokensForTokens(
                amountIn,
                minAmountOut,
                path,
                target,
                block.timestamp
            );
        return returned[returned.length - 1];
    }
}
