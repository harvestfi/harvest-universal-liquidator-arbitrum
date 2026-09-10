# Harvest Universal Liquidator Arbitrum

## Structure
- In helpers/token-pairs.json, helpers/pools.json, and helpers/intermediate-tokens.json, the list between test and production is separated.

## Get Started

```shell
yarn
yarn test
```

### Test locally
```shell
yarn  test
```

### Deploy locally
In **1st** terminal session
```shell
# start local node
yarn hardhat node 
```

In **2nd** terminal session

```shell
# deploy base contracts
yarn hardhat run scripts/deploy-ul-base.ts --network localhost
```

```shell
# deploy dex
yarn hardhat run scripts/deploy-dex.ts --network localhost
# input the following parameters
✔ Which dex do you want to deploy? (Ex: UniV3Dex, the contract name) … 
✔ Which name do you want to represent the dex? (Ex: uniV3) … 
```

```shell
# set fees
yarn hardhat run scripts/set-fees.ts --network localhost
```

```shell
# set pools
yarn hardhat run scripts/set-pools.ts --network localhost
```

```shell
# set token pairs
yarn hardhat run scripts/set-paths.ts --network localhost
```
## Registry maintenance

The `UniversalLiquidatorRegistry` emits no events and its `paths` mapping has no
enumerator, so the configured routes cannot be listed from the chain directly.
`helpers/registry.json` is the checked-in record of what the registry is *supposed* to
contain; the tooling diffs it against what is actually deployed.

```shell
yarn registry:audit                  # 1. is the chain what the manifest says?
yarn registry:routes                 # 2. find better routes -> proposals file
#                                      3. review that file
yarn registry:apply                  # 4. dry run: see the transactions
APPLY_EXECUTE=1 yarn registry:apply  # 5. send them (updates the manifest)
yarn registry:audit                  # 6. confirm
```

**Set `REGISTRY_RPC_URL` first**, in `.env` or inline:

```shell
REGISTRY_RPC_URL=https://arbitrum-one-rpc.publicnode.com
```

To send transactions, also set `REGISTRY_PRIVATE_KEY` (or `MNEMONIC`). The signer
must be the registry owner; the scripts refuse otherwise.

`registry:seed` rebuilds the manifest from the chain, needed only when paths were
changed outside this tooling. `registry:sync` is the opposite direction, for when
the manifest is edited by hand and the chain has to catch up.

### What the audit checks

Errors (exit code 1): the UL points at this registry; every dex resolves to the
manifest address and none to `address(0)`; intermediate tokens match **in order**
(`getPath` returns the first match, so order decides routing); every manifest path
exists on chain with the same dex and token array, and no chain path is missing
from the manifest; every hop resolves to a pool that is actually deployed; and
no concentrated-liquidity hop sits on a pool with zero active liquidity. That
last one can hold plenty of both tokens while every position is out of range,
and it reverts on any swap — a `doHardWork` that reverts, not a bad price.

Warnings: a hop's pool below its `minLiquidity` floor, a pair with no reverse
path, a UniV3 hop on the default fee (indistinguishable from unset), and any dex
whose `kind` is `unknown`.

### Proposing better routes

`registry:routes` quotes every registered route against alternatives on the other
dexes and writes what it finds to the proposals file. Test swaps are sized in
**dollars** (`PROPOSE_USD`, default 1000) because that is the size a liquidation
actually is. There is no price feed: each sell token is priced by quoting a
sliver of its deepest pool into `usdAnchor`.

`registry:apply` turns those back into transactions, re-quoting every proposal
first because prices move. A proposal is more than a `setPath`: the dex needs the
pair config the quote was taken with, so the `setFee` / `setTickSpacing` /
`pairSetup` calls are emitted before it.

A registered route that does not quote at all is treated as broken rather than
merely worse: there is no percentage to compare, so any alternative that does
quote is proposed for it. That is what catches a pool that has drained or whose
liquidity has moved out of range.

A token not in the registry yet has no route to compare, so it has to be named.
`PROPOSE_NEW_TOKENS` takes addresses — inline, or a file to scan for them — and
looks for a route from each to every intermediate token, quoted the same way.
Acceptance is by value kept rather than by beating an incumbent: a new route has
to retain `PROPOSE_MIN_RETENTION` (default 90%) of the input value, because an
illiquid token quotes something through almost any pool and a route that gives up
half the value is worse than having none. `registry:apply` sends these like any
other proposal and adds the token and its paths to the manifest.

```shell
PROPOSE_NEW_TOKENS=0xAbC…,0xDeF… yarn registry:routes
PROPOSE_NEW_TOKENS=new-vaults.txt yarn registry:routes   # every 0x… in the file
```

Dexes marked `kind: "unknown"` on Arbitrum are skipped by both the hop checks and
the proposer — they do not fit any resolution shape the tooling knows.
