// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../interface/aerodrome/ISwapRouter.sol";

/**
 * Test-only stand-in for the Slipstream router, installed at its address with hardhat_setCode.
 * It takes only half the input when amountIn ends in 7, the way a pool that runs out of liquidity
 * stops at the price limit, and the whole input otherwise; it pays out amountIn + 7 of tokenOut from
 * its own balance. Uses no storage, so it works over the real router's.
 */
contract MockSlipstreamRouter {
    function exactInputSingle(
        ISwapRouter.ExactInputSingleParams calldata params
    ) external payable returns (uint256 amountOut) {
        uint256 consumed = params.amountIn % 10 == 7
            ? params.amountIn / 2
            : params.amountIn;
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), consumed);
        amountOut = params.amountIn + 7;
        require(amountOut >= params.amountOutMinimum, "Too little received");
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}
