// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

// interfaces
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interface/IUniversalLiquidator.sol";
import "../interface/IUniversalLiquidatorRegistry.sol";
import "../interface/ILiquidityDex.sol";

// librarise
import "../libraries/DataTypes.sol";

contract UniversalLiquidator is Ownable, IUniversalLiquidator {
    using SafeMath for uint256;
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

        IERC20(swapInfo[0].paths[0]).safeTransferFrom(
            _receiver,
            address(this),
            _sellAmount
        );

        for (uint256 i = 0; i < swapInfo.length; i++) {
            _swap(
                IERC20(swapInfo[i].paths[0]).balanceOf(address(this)),
                _minBuyAmount,
                address(this),
                swapInfo[i].dex,
                swapInfo[i].paths
            );
        }

        DataTypes.SwapInfo memory lastSwap = swapInfo[swapInfo.length - 1];

        require(
            _minBuyAmount <
                IERC20(lastSwap.paths[lastSwap.paths.length - 1]).balanceOf(
                    address(this)
                ),
            "Didn't obtain more than _minBuyAmount"
        );
        IERC20(lastSwap.paths[lastSwap.paths.length - 1]).safeTransfer(
            _receiver,
            IERC20(lastSwap.paths[lastSwap.paths.length - 1]).balanceOf(
                address(this)
            )
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
            _path[_path.length - 1],
            _path[0],
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
