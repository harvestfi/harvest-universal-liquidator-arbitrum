// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Test-only token, the whole supply minted to the deployer.
contract TestToken is ERC20 {
    constructor(string memory _symbol) ERC20(_symbol, _symbol) {
        _mint(msg.sender, 1e30);
    }
}
