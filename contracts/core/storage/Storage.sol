// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import "../../libraries/Dexes.sol";
import "../../libraries/Tokens.sol";
import "../../libraries/DataTypes.sol";

abstract contract ULRegistryStorage {
    mapping(address => mapping(address => DataTypes.PathInfo)) public paths;
    mapping(bytes32 => address) public dexesInfo;

    bytes32[] public allDexes;
    address[] public intermediateTokens;

    constructor() public {
        // preset for the already in use crops
        address[] memory _paths = new address[](2);
        _paths[0] = Tokens.weth;
        _paths[1] = Tokens.farm;
        paths[Tokens.weth][Tokens.farm] = DataTypes.PathInfo({
            dex: Dexes.uniDex,
            paths: _paths
        });
        _paths = new address[](3);
        _paths[0] = Tokens.dai;
        _paths[1] = Tokens.weth;
        _paths[2] = Tokens.farm;
        paths[Tokens.dai][Tokens.farm] = DataTypes.PathInfo({
            dex: Dexes.uniDex,
            paths: _paths
        });
        _paths = new address[](2);
        _paths[0] = Tokens.usdc;
        _paths[1] = Tokens.farm;
        paths[Tokens.usdc][Tokens.farm] = DataTypes.PathInfo({
            dex: Dexes.uniDex,
            paths: _paths
        });
        _paths = new address[](3);
        _paths[0] = Tokens.usdt;
        _paths[1] = Tokens.weth;
        _paths[2] = Tokens.farm;
        paths[Tokens.usdt][Tokens.farm] = DataTypes.PathInfo({
            dex: Dexes.uniDex,
            paths: _paths
        });

        // Other preset path
        /*dexPaths[uniDex][wbtc][farm] = [wbtc, weth, farm];
        dexPaths[uniDex][renBTC][farm] = [renBTC, weth, farm];

        // use Sushiswap for SUSHI, convert into WETH
        dexPaths[sushiDex][sushi][weth] = [sushi, weth];

        dexPaths[uniDex][dego][farm] = [dego, weth, farm];
        dexPaths[uniDex][crv][farm] = [crv, weth, farm];
        dexPaths[uniDex][comp][farm] = [comp, weth, farm];

        dexPaths[uniDex][idx][farm] = [idx, weth, farm];
        dexPaths[uniDex][idle][farm] = [idle, weth, farm];

        // use Sushiswap for MIS -> USDT
        dexPaths[sushiDex][mis][usdt] = [mis, usdt];
        dexPaths[uniDex][bsg][farm] = [bsg, dai, weth, farm];
        dexPaths[uniDex][bas][farm] = [bas, dai, weth, farm];
        dexPaths[uniDex][bsgs][farm] = [bsgs, dai, weth, farm];
        dexPaths[uniDex][kbtc][farm] = [kbtc, wbtc, weth, farm];*/
    }
}
