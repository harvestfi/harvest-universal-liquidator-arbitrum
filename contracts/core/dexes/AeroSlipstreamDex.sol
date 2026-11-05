// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/aerodrome/ISwapRouter.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {AeroSlipstreamDexStorage} from "../storage/AeroSlipstreamDex.sol";

/**
 * Slipstream-style concentrated liquidity dex (pools addressed by tick spacing), ported from the
 * Base liquidator's AeroSlipstreamDex. It differs from the Base version in two ways:
 *
 * - It swaps one hop at a time with exactInputSingle instead of handing the whole path to
 *   exactInput, and reverts with PartialFill when a hop leaves input behind. With exactInput a
 *   pool that runs out of liquidity stops at the price limit, the router keeps the unspent
 *   intermediate input (anyone can sweepToken it) and the call still succeeds against a minimum
 *   output of 1. That happened on Base with UniV3Dex on 2026-10-23, which is why the Base repo has
 *   UniV3ExactDex. Intermediate outputs come back to this contract and the next hop spends exactly
 *   that amount; amounts out are the same as exactInput along the same pools.
 * - A pair without a tick spacing reverts with TickSpacingNotSet. The Base version encodes 0, which
 *   points the router at an address with no pool and reverts without a reason.
 */
contract AeroSlipstreamDex is Ownable, ILiquidityDex, AeroSlipstreamDexStorage {
    using SafeERC20 for IERC20;

    error PartialFill(address token, uint256 consumed, uint256 amountIn);
    error TickSpacingNotSet(address token0, address token1);

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        uint256 amount = _sellAmount;
        uint256 lastHop = _path.length - 1;
        for (uint256 idx; idx < lastHop; ) {
            bool isLast = idx + 1 == lastHop;
            amount = _swapHop(
                _path[idx],
                _path[idx + 1],
                amount,
                isLast ? _minBuyAmount : 1,
                isLast ? _receiver : address(this)
            );
            unchecked {
                ++idx;
            }
        }
        return amount;
    }

    function _swapHop(
        address _tokenIn,
        address _tokenOut,
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipient
    ) internal returns (uint256 amountOut) {
        int24 spacing = _tickSpacing[_tokenIn][_tokenOut];
        if (spacing == 0) revert TickSpacingNotSet(_tokenIn, _tokenOut);

        uint256 balanceBefore = IERC20(_tokenIn).balanceOf(address(this));
        IERC20(_tokenIn).safeIncreaseAllowance(
            Addresses.aeroSlipstreamRouter,
            _amountIn
        );
        amountOut = ISwapRouter(Addresses.aeroSlipstreamRouter)
            .exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: _tokenIn,
                    tokenOut: _tokenOut,
                    tickSpacing: spacing,
                    recipient: _recipient,
                    deadline: block.timestamp,
                    amountIn: _amountIn,
                    amountOutMinimum: _minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );

        uint256 consumed = balanceBefore -
            IERC20(_tokenIn).balanceOf(address(this));
        if (consumed != _amountIn)
            revert PartialFill(_tokenIn, consumed, _amountIn);
    }

    function tickSpacing(
        address _sellToken,
        address _buyToken
    ) public view returns (int24) {
        return _tickSpacing[_sellToken][_buyToken];
    }

    function setTickSpacing(
        address _token0,
        address _token1,
        int24 _spacing
    ) external onlyOwner {
        _tickSpacing[_token0][_token1] = _spacing;
        _tickSpacing[_token1][_token0] = _spacing;
    }

    receive() external payable {}
}
