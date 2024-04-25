// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/erc4626/IERC4626.sol";

// libraries
import "../../libraries/Addresses.sol";

contract ERC4626Dex is Ownable, ILiquidityDex {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        require (_path.length == 2, 'Path length needs to be 2');
        address sellToken = _path[0];
        address buyToken = _path[1];

        if (isERC4626(sellToken)) {
            require (checkUnderlying(sellToken, buyToken), 'Underlying mismatch');
            IERC4626(sellToken).redeem(_sellAmount, address(this), address(this));
        } else if (isERC4626(buyToken)) {
            require (checkUnderlying(buyToken, sellToken), 'Underlying mismatch');
            IERC20(sellToken).safeIncreaseAllowance(
                buyToken,
                _sellAmount
            );
            IERC4626(buyToken).deposit(_sellAmount, address(this));
        } else {
            revert('No ERC4626');
        }

        uint256 output = IERC20(buyToken).balanceOf(address(this));
        require(output >= _minBuyAmount, 'Too little received');
        IERC20(buyToken).safeTransfer(_receiver, output);
        return output;
    }

    function isERC4626(address token) internal view returns(bool) {
        try IERC4626(token).asset() returns (address underlying) {
            if (underlying != address(0)) {
                return true;
            } else {
                return false;
            }
        } catch {
            return false;
        }
    }

    function checkUnderlying(address token, address underlying) internal view returns(bool) {
        return (IERC4626(token).asset() == underlying);
    }

    receive() external payable {}
}
