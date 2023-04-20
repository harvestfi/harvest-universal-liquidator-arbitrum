// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

// imported contracts and libraries
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// interfaces
import "../../interface/ILiquidityDex.sol";
import "../../interface/balancer/IBVault.sol";

// libraries
import "../../libraries/Addresses.sol";

contract BalancerDex is ILiquidityDex, Ownable {
    using SafeERC20 for IERC20;

    receive() external payable {}

    address public weth = address(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    address public bal = address(0xba100000625a3754423978a60c9317c58a424e3D);
    address public note = address(0xCFEAead4947f0705A14ec42aC3D44129E1Ef3eD5);

    mapping(address => mapping(address => bytes32)) public poolIds;

    constructor() {
        poolIds[weth][bal] = bytes32(
            0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014
        );
        poolIds[bal][weth] = bytes32(
            0x5c6ee304399dbdb9c8ef030ab642b10820db8f56000200000000000000000014
        );
        poolIds[weth][note] = bytes32(
            0x5122e01d819e58bb2e22528c0d68d310f0aa6fd7000200000000000000000163
        );
        poolIds[note][weth] = bytes32(
            0x5122e01d819e58bb2e22528c0d68d310f0aa6fd7000200000000000000000163
        );
    }

    function changePoolId(
        address _token0,
        address _token1,
        bytes32 _poolId
    ) external onlyOwner {
        poolIds[_token0][_token1] = _poolId;
        poolIds[_token1][_token0] = _poolId;
    }

    function doSwap(
        uint256 amountIn,
        uint256 minAmountOut,
        address target,
        address[] memory path
    ) public override returns (uint256) {
        require(path.length == 2, "Only supports single swaps");
        address buyToken = path[1];
        address sellToken = path[0];

        IBVault.SingleSwap memory singleSwap;
        IBVault.SwapKind swapKind = IBVault.SwapKind.GIVEN_IN;

        singleSwap.poolId = poolIds[sellToken][buyToken];
        singleSwap.kind = swapKind;
        singleSwap.assetIn = IAsset(sellToken);
        singleSwap.assetOut = IAsset(buyToken);
        singleSwap.amount = amountIn;
        singleSwap.userData = abi.encode(0);

        IBVault.FundManagement memory funds;
        funds.sender = address(this);
        funds.fromInternalBalance = false;
        funds.recipient = payable(target);
        funds.toInternalBalance = false;

        IERC20(sellToken).safeIncreaseAllowance(
            Addresses.balancerVault,
            amountIn
        );

        return
            IBVault(Addresses.balancerVault).swap(
                singleSwap,
                funds,
                minAmountOut,
                block.timestamp
            );
    }
}
