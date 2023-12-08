// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/traderJoe/ILBRouter.sol";

// libraries
import "../../libraries/Addresses.sol";

// constants and types
import {TraderJoeDexStorage} from "../storage/TraderJoeDex.sol";

contract TraderJoeDex is Ownable, ILiquidityDex, TraderJoeDexStorage {
    using SafeERC20 for IERC20;

    function doSwap(
        uint256 _sellAmount,
        uint256 _minBuyAmount,
        address _receiver,
        address[] memory _path
    ) external override returns (uint256) {
        address sellToken = _path[0];

        IERC20(sellToken).safeIncreaseAllowance(
            Addresses.traderJoeRouter,
            _sellAmount
        );

        ILBRouter.Path memory path;
        uint256[] memory pairBinSteps = new uint256[](_path.length - 1);
        ILBRouter.Version[] memory versions = new ILBRouter.Version[](_path.length - 1);
        for (uint256 idx; idx < _path.length - 1; ) {
            address curSellToken = _path[idx];
            address curBuyToken = _path[idx + 1];

            pairBinSteps[idx] = getBinStep(curSellToken, curBuyToken);
            versions[idx] = getVersion(curSellToken, curBuyToken);

            unchecked {
                ++idx;
            }
        }
        path.tokenPath = _path;
        path.pairBinSteps = pairBinSteps;
        path.versions = versions;

        ILBRouter(Addresses.traderJoeRouter)
            .swapExactTokensForTokens(
                _sellAmount,
                _minBuyAmount,
                path,
                _receiver,
                block.timestamp
            );
    }

    function setPairParams(
        address _token0,
        address _token1,
        uint256 __binStep,
        uint256 __version
    ) external onlyOwner {
        _binStep[_token0][_token1] = __binStep;
        _binStep[_token1][_token0] = __binStep;
        _version[_token0][_token1] = availableVersions[__version];
        _version[_token1][_token0] = availableVersions[__version];
    }

    function getBinStep(
        address _token0,
        address _token1
    ) public view returns (uint256) {
        return _binStep[_token0][_token1];
    }

    function getVersion(
        address _token0,
        address _token1
    ) public view returns (ILBRouter.Version) {
        return _version[_token1][_token0];
    }

    receive() external payable {}
}
