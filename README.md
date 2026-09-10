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

A pair with nothing registered has no route to compare against, so it has to be
asked for. `PROPOSE_NEW_PAIRS` takes `SELL>BUY` entries (`->` works too),
comma, space or newline separated, inline or in a file, and either side may be
an address or a symbol the manifest already names. `PROPOSE_NEW_TOKENS` is the
shorthand for a new reward token: one address expands to that token against
every intermediate, which is all the registry needs.

```shell
PROPOSE_NEW_PAIRS="0xAbC…>cbBTC, WETH -> 0xDeF…" yarn registry:routes
PROPOSE_NEW_PAIRS=wanted.txt yarn registry:routes
PROPOSE_NEW_TOKENS=0xAbC… yarn registry:routes
```

Candidates are quoted exactly as for a registered pair; what differs is the
accept test. With no incumbent to beat, a route is judged on value kept: it has
to retain `PROPOSE_MIN_RETENTION` (default 90%) of the input, because an
illiquid token quotes something through almost any pool and a route that gives
up half the value is worse than having none. A pair that *is* registered is
compared the ordinary way instead. `registry:apply` sends these like any other
proposal and adds the tokens and paths to the manifest.

Dexes marked `kind: "unknown"` on Arbitrum are skipped by both the hop checks and
the proposer — they do not fit any resolution shape the tooling knows.
