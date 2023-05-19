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