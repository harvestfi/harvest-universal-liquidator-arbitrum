// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/camelot/ICamelotRouter.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {CamelotDexStorage} from "../storage/CamelotDex.sol";

contract CamelotDex is Ownable, ILiquidityDex, CamelotDexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeIncreaseAllowance(
            Addresses.camelotRouter,
            _sellAmount
        );

        ICamelotRouter(Addresses.camelotRouter)
            .swapExactTokensForTokensSupportingFeeOnTransferTokens(
                _sellAmount,
                _minBuyAmount,
                _path,
                _receiver,
                _referrer,
                block.timestamp
            );
    }

    function setReferrer(address newReferrer) external onlyOwner {
        _referrer = newReferrer;
    }

    function referrer() public view returns (address) {
        return _referrer;
    }

    receive() external payable {}
}
