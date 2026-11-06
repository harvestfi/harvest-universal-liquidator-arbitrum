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

Hardhat 2.13.1 can no longer fork Arbitrum on its own: every Arbitrum RPC now
omits `totalDifficulty` from blocks, and this Hardhat refuses a fork block
without it. `yarn fork:proxy` forwards to the real RPC and fills the field in;
point the fork at it with `FORK_URL` (and pin a block with `FORK_BLOCK` so
Hardhat caches it). Without a `MNEMONIC` the fork uses Hardhat's default test
accounts.

```shell
FORK_UPSTREAM_URL=https://arb-mainnet.g.alchemy.com/v2/<key> yarn fork:proxy   # 1st terminal
FORK_URL=http://127.0.0.1:8546 FORK_BLOCK=521479000 yarn test                  # 2nd terminal
```

### Slipstream fork tests

The Slipstream pools behind `AeroSlipstreamDex` cannot be swapped on this
Hardhat at all: their swap hook (`0xC0ed888AfE87ed1AcF01D9f19bB850159e3ce434`)
uses `TLOAD`/`TSTORE`, which needs Cancun, and calls the ArbSys precompile at
`0x64` (`arbBlockNumber()`), which no fork has. `tests/slipstream.test.ts`
therefore runs against anvil, installs `contracts/test/ArbSysStub.sol` at
`0x64`, and skips itself on the in-process network. It swaps through a
UniversalLiquidator at $10, $1,000 and $50,000 on every USDG route and
requires the output to equal the meta quoter's quote taken on the real chain
at the fork block. The hook's fee decays with time, so the test pins anvil's
clock to the fork block for every case. Start anvil fresh for each run.

```shell
anvil --fork-url https://arb-mainnet.g.alchemy.com/v2/<key> --fork-block-number 521479000   # 1st terminal
yarn test:slipstream                                                                          # 2nd terminal, needs ALCHEMEY_KEY
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

### Findings you have decided to live with

A real finding that will not be fixed — a path registered on chain that cannot
be withdrawn, since the registry has no `removePath` — can be declared in the
manifest's `accepted` list with a `group`, a `contains` substring, and a
required `reason`. Matching is narrow, so a different failure on the same path
still errors. Excused findings are still printed under `ACCEPTED` with their
reason, but do not fail the run, and an entry that stops matching anything is
reported as `stale-accepted` so it gets cleaned up.

An entry can instead carry a `sellToken`, which excuses every finding about a
path selling that token — for a token that cannot be liquidated at all, where
naming each path separately says the same thing repeatedly and goes stale as
soon as another path is added.

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

A route can also fill the test size and still be dead at a liquidation's size:
a pool with plenty of the sell token and almost none of the buy token pays about
the same for $10000 as for $1000. So every registered route is quoted a second
time, at `PROPOSE_CAP_FACTOR` times the size (default 10), and one whose output
falls short of scaling by more than `PROPOSE_CAP_LOSS` (default `0.25`) is
treated as **capped** there: the alternatives are weighed at that size instead,
provided they give up nothing beyond a basis point of rounding at the headline
size, and the proposal says so and carries the size, so `registry:apply`
re-quotes it there and at the headline size. Falling short is a gate, not a verdict: a route into a thin
token falls short on every venue, and is only proposed if another venue does
materially better there. `PROPOSE_VERBOSE=1` prints each route's share of
linear scaling.

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

A pair with no entry of its own may still be reachable: `getPath` falls back to
the first intermediate token with a path on both sides and swaps in two legs,
and since each leg is itself multi-hop, that can cross more pools than any one
entry. The proposer reads what the registry does today and weighs a direct entry
against it, reporting rather than proposing one that would not improve on it
(the per-leg shares are multiplied, so it is approximate).

Candidates are quoted exactly as for a registered pair; what differs is the
accept test. With no incumbent to beat, a route is judged on value kept: it has
to retain `PROPOSE_MIN_RETENTION` (default 90%) of the input, because an
illiquid token quotes something through almost any pool and a route that gives
up half the value is worse than having none. A pair that *is* registered is
compared the ordinary way instead. `registry:apply` sends these like any other
proposal and adds the tokens and paths to the manifest.

### Adding the Slipstream dex (`aeroSlipstream`) for USDG

USDG's only liquidity the older dexes reach is a ~$500 Uniswap V3 pool, so the
interim `uniV3` routes `USDG > USDC > WETH` and `WETH > USDC > USDG` cap out
at a few hundred dollars. `AeroSlipstreamDex` swaps on the Slipstream-style
factory `0x88a60ee77392577c355C0acb2A8d476D5a4EC03a` through its router
`0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418`. The manifest already lists it
with an empty `address`; the audit warns about that and `registry:apply`
holds its routes back until the address is filled in.

The deploy has to come from the registry owner (`0x6a74…5Aa2`): `deploy:dex`
calls `addDex`, and the adapter's owner, who alone can `setTickSpacing`, is
whoever deploys it. `deploy:dex` signs with the `MNEMONIC` account,
`registry:apply` with `REGISTRY_PRIVATE_KEY` or `MNEMONIC`.

```shell
# 1. deploy AeroSlipstreamDex and addDex(keccak256("aeroSlipstream") = 0x6ac70dc6…7b79, address)
DEX_FILE=AeroSlipstreamDex DEX_NAME=aeroSlipstream yarn deploy:dex
# 2. the script does not wait for addDex; check it landed (should print the new address)
cast call 0xbcE9d31FfA2c96E11cEbEAa021136a83A3575D95 "dexesInfo(bytes32)(address)" \
  0x6ac70dc663911fae943651c037eb5dea83590bc0d91936e52ab434329ecc7b79 --rpc-url $REGISTRY_RPC_URL
# 3. put the address (lowercase) in helpers/registry.json under dexes -> aeroSlipstream,
#    and add "aeroSlipstream": { "hex": "0x6ac7…7b79", "address": … } to deployments.json
yarn registry:audit    # 4. aeroSlipstream registered at the manifest address
yarn registry:routes   # 5. proposes WETH > USDC > USDG and USDG > USDC > WETH on aeroSlipstream
yarn registry:apply    # 6. dry run, see below
APPLY_EXECUTE=1 yarn registry:apply   # 7. send
yarn registry:audit    # 8. confirm
```

The dry run should list four transactions, tick spacings before paths, so no
harvest in between can reach a pair the adapter has no pool for (it would
revert with `TickSpacingNotSet`, not lose funds):

1. `setTickSpacing(WETH, USDC, 100)` on the new adapter
2. `setTickSpacing(USDC, USDG, 1)` on the new adapter
3. `setPath(aeroSlipstream, [WETH, USDC, USDG])` on the registry, replacing the `uniV3` entry
4. `setPath(aeroSlipstream, [USDG, USDC, WETH])` on the registry, replacing the `uniV3` entry

`USDG > iFARM` needs no entry of its own: `getPath` composes it through WETH
with the existing camelot `WETH > iFARM`. EURe stays on its interim `uniV3`
routes; the proposer finds nothing better for it on this venue.

`AeroSlipstreamDex` differs from the Base version in two ways (see the
contract's header): it swaps one hop at a time and reverts with `PartialFill`
if a pool leaves input behind instead of letting the router keep it, and a
pair with no tick spacing reverts with `TickSpacingNotSet`. Outputs are the
same as the Base version's `exactInput` along the same pools.

### Watching it on a schedule

`registry:watch` runs the same checks and speaks up only when something needs
doing — audit errors, registered routes that no longer quote, and routes better
by at least `WATCH_MIN_BPS` (default 1%). It holds no key and sends no
transaction; applying stays manual.

```shell
WATCH_DRY=1 yarn registry:watch          # print what it would say
WATCH_MODE=audit yarn registry:watch     # just the breakage check
```

`.github/workflows/registry-watch.yml` runs the audit daily and adds the route
check weekly. Breakage is worth knowing the same day; route improvements move
with liquidity and a percent seen on Tuesday is often gone by Thursday. Add
`REGISTRY_RPC_URL` plus `WATCH_DISCORD_WEBHOOK`, or `WATCH_TELEGRAM_TOKEN` with
`WATCH_TELEGRAM_CHAT`, as repository secrets.

Dexes marked `kind: "unknown"` on Arbitrum are skipped by both the hop checks and
the proposer — they do not fit any resolution shape the tooling knows.
