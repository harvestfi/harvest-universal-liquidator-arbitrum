// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "./UniBasedDex.sol";

contract SushiswapDex is
    UniBasedDex(
        0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F,
        0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac
    )
{}
