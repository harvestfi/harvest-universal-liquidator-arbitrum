// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/camelot/ISwapRouter.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types

contract CamelotV3Dex is Ownable, ILiquidityDex {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeIncreaseAllowance(
            Addresses.camelotV3Router,
            _sellAmount
        );

        bytes memory encodedPath = abi.encodePacked(sellToken);
        for (uint256 idx = 1; idx < _path.length; ) {
            encodedPath = abi.encodePacked(
                encodedPath,
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

        return ISwapRouter(Addresses.camelotV3Router).exactInput(param);
    }

    receive() external payable {}
}
