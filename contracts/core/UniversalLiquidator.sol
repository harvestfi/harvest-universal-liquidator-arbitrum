// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// interfaces
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interface/IUniversalLiquidator.sol";
import "../interface/IUniversalLiquidatorRegistry.sol";
import "../interface/ILiquidityDex.sol";

// librarise
import "../libraries/DataTypes.sol";
import "../libraries/Errors.sol";

contract UniversalLiquidator is Ownable, IUniversalLiquidator {
    using SafeERC20 for IERC20;

    address public pathRegistry;

    function swapTokenOnMultipleDEXes(
        address _sellToken,
        address _buyToken,
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver
    ) external override returns (uint256) {
        DataTypes.SwapInfo[] memory swapInfo = IUniversalLiquidatorRegistry(
            pathRegistry
        ).getPath(_sellToken, _buyToken);

        IERC20(_sellToken).safeTransferFrom(
            msg.sender,
            address(this),
            _sellAmount
        );

        for (uint256 idx; idx < swapInfo.length; ) {
            _swap(
                IERC20(swapInfo[idx].paths[0]).balanceOf(address(this)),
                _minBuyAmount,
                address(this),
                swapInfo[idx].dex,
                swapInfo[idx].paths
            );
            unchecked {
                ++idx;
            }
        }

        if (_minBuyAmount > IERC20(_buyToken).balanceOf(address(this)))
            revert Errors.AmountUnmatch();

        IERC20(_buyToken).safeTransfer(
            _receiver,
            IERC20(_buyToken).balanceOf(address(this))
        );
    }

    function _swap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address _dex,
        address[] memory _path
    ) internal {
        IERC20(_path[0]).safeApprove(_dex, 0);
        IERC20(_path[0]).safeApprove(_dex, _sellAmount);

        ILiquidityDex(_dex).doSwap(
            _sellAmount,
            _minBuyAmount,
            address(this),
            _receiver,
            _path
        );

        emit Swap(
            _path[0],
            _path[_path.length - 1],
            _receiver,
            msg.sender,
            _sellAmount,
            _minBuyAmount
        );
    }

    function setPathRegistry(address _pathRegistry) public onlyOwner {
        pathRegistry = _pathRegistry;
    }

    receive() external payable {}
}
