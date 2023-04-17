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

// constants and types
import {UniswapV3DexStorage} from "../storage/UniswapV3Dex.sol";

contract UniV3Dex is Ownable, ILiquidityDex, UniswapV3DexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _spender,
        address _receiver,
        address[] memory _path
    ) public override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeTransferFrom(
            _spender,
            address(this),
            _sellAmount
        );

        IERC20(sellToken).safeIncreaseAllowance(
            Addresses.uniswapV3Router,
            _sellAmount
        );

        bytes memory encodedPath = abi.encodePacked(sellToken);
        for (uint256 idx = 1; idx < _path.length; ) {
            encodedPath = abi.encodePacked(
                encodedPath,
                pairFee(_path[idx - 1], _path[idx]),
                _path[idx]
            );
            unchecked {
                ++idx;
            }
        }

        ISwapRouter.ExactInputParams memory param = ISwapRouter
            .ExactInputParams({
                path: encodedPath,
                recipient: _receiver,
                deadline: block.timestamp,
                amountIn: _sellAmount,
                amountOutMinimum: _minBuyAmount
            });

        uint256 actualAmountOut = ISwapRouter(Addresses.uniswapV3Router)
            .exactInput(param);
        return actualAmountOut;
    }

    function pairFee(
        address _sellToken,
        address _buyToken
    ) public view returns (uint24 fee) {
        if (_pairFee[_sellToken][_buyToken] != 0) {
            return _pairFee[_sellToken][_buyToken];
        } else if (_pairFee[_buyToken][_sellToken] != 0) {
            return _pairFee[_buyToken][_sellToken];
        } else {
            return 3000;
        }
    }

    function setFee(
        address _token0,
        address _token1,
        uint24 _fee
    ) public onlyOwner {
        _pairFee[_token0][_token1] = _fee;
    }

    receive() external payable {}
}
