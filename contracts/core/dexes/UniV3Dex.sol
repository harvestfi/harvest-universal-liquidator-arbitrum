// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../../interface/ILiquidityDex.sol";
import "../../interface/uniswap/ISwapRouter.sol";

contract UniV3Dex is ILiquidityDex, Ownable {
    using SafeERC20 for IERC20;

    address constant uniswapV3Router =
        0xE592427A0AEce92De3Edee1F18E0157C05861564;

    mapping(address => mapping(address => uint24)) public storedPairFee;

    constructor() public {
        address fcash = 0x531261a091F31bFd93dd393a6CA447ed6Fb2043C;
        address dai = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
        address usdc = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
        address usdt = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
        address eurs = 0xdB25f211AB05b1c97D595516F45794528a807ad8;
        storedPairFee[dai][usdc] = 500;
        storedPairFee[dai][usdt] = 500;
        storedPairFee[usdc][usdt] = 500;
        storedPairFee[fcash][usdc] = 500;
        storedPairFee[usdc][eurs] = 500;
    }

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
            uniswapV3Router,
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

        uint256 actualAmountOut = ISwapRouter(uniswapV3Router).exactInput(
            param
        );
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
