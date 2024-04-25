// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/aave/IPool.sol";
import "../../interface/aave/IAToken.sol";

// libraries
import "../../libraries/Addresses.sol";

contract AaveDex is Ownable, ILiquidityDex {
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

        if (isAToken(sellToken)) {
            require (checkUnderlying(sellToken, buyToken), 'Underlying mismatch');
            IPool(Addresses.aaveV3Pool).withdraw(buyToken, _sellAmount, address(this));
        } else if (isAToken(buyToken)) {
            require (checkUnderlying(buyToken, sellToken), 'Underlying mismatch');
            IERC20(sellToken).safeIncreaseAllowance(
                Addresses.aaveV3Pool,
                _sellAmount
            );
            IPool(Addresses.aaveV3Pool).supply(sellToken, _sellAmount, address(this), 0);
        } else {
            revert('No aToken');
        }

        uint256 output = IERC20(buyToken).balanceOf(address(this));
        require(output >= _minBuyAmount, 'Too little received');
        IERC20(buyToken).safeTransfer(_receiver, output);
        return output;
    }

    function isAToken(address token) internal view returns(bool) {
        try IAToken(token).UNDERLYING_ASSET_ADDRESS() returns (address underlying) {
            if (underlying != address(0)) {
                return true;
            } else {
                return false;
            }
        } catch {
            return false;
        }
    }

    function checkUnderlying(address aToken, address underlying) internal view returns(bool) {
        return (IAToken(aToken).UNDERLYING_ASSET_ADDRESS() == underlying);
    }

    receive() external payable {}
}
