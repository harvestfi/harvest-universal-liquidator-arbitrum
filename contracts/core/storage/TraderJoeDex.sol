// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../../interface/traderJoe/ILBRouter.sol";

abstract contract TraderJoeDexStorage {
    mapping(address => mapping(address => uint256)) internal _binStep;
    mapping(address => mapping(address => ILBRouter.Version)) internal _version;
    ILBRouter.Version[] availableVersions = [ILBRouter.Version.V1, ILBRouter.Version.V2, ILBRouter.Version.V2_1];
}
