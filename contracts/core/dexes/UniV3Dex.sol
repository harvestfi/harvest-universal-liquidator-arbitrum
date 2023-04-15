// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/uniswap/ISwapRouter.sol";

// libraries
import "../../libraries/Addresses.sol";

contract UniV3Dex is ILiquidityDex, Ownable {
    using SafeERC20 for IERC20;

    mapping(address => mapping(address => uint24)) public storedPairFee;

    function doSwap(
        uint256 amountIn,
        uint256 minAmountOut,
        address spender,
        address target,
        address[] memory pathWithoutFee
    ) public override returns (uint256) {
        address currentSellToken = pathWithoutFee[0];

        IERC20(currentSellToken).safeTransferFrom(
            spender,
            address(this),
            amountIn
        );
        IERC20(currentSellToken).safeIncreaseAllowance(
            Addresses.uniswapV3Router,
            amountIn
        );

        bytes memory pathWithFee = abi.encodePacked(currentSellToken);
        for (uint256 i = 1; i < pathWithoutFee.length; i++) {
            address currentBuyToken = pathWithoutFee[i];
            pathWithFee = abi.encodePacked(
                pathWithFee,
                pairFee(currentSellToken, currentBuyToken),
                currentBuyToken
            );
            currentSellToken = currentBuyToken;
        }

        ISwapRouter.ExactInputParams memory param = ISwapRouter
            .ExactInputParams({
                path: pathWithFee,
                recipient: target,
                deadline: block.timestamp,
                amountIn: amountIn,
                amountOutMinimum: minAmountOut
            });

        uint256 actualAmountOut = ISwapRouter(Addresses.uniswapV3Router)
            .exactInput(param);
        return actualAmountOut;
    }

    function pairFee(
        address sellToken,
        address buyToken
    ) public view returns (uint24 fee) {
        if (storedPairFee[sellToken][buyToken] != 0) {
            return storedPairFee[sellToken][buyToken];
        } else if (storedPairFee[buyToken][sellToken] != 0) {
            return storedPairFee[buyToken][sellToken];
        } else {
            return 3000;
        }
    }

    function setFee(
        address token0,
        address token1,
        uint24 fee
    ) public onlyOwner {
        storedPairFee[token0][token1] = fee;
    }

    receive() external payable {}
}
