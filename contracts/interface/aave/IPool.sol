// SPDX-License-Identifier: AGPL-3.0
pragma solidity 0.8.17;

import "./DataTypes.sol";

interface IPool {
  function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external;
  function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external;
  function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
  function withdraw(address asset, uint256 amount, address to) external;
  function getConfiguration(address asset) external view returns (DataTypes.ReserveConfigurationMap memory);
}