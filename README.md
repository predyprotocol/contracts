# contracts

![](https://github.com/predyprotocol/contracts/workflows/Test/badge.svg)
[![codecov](https://codecov.io/gh/predyprotocol/contracts/branch/main/graph/badge.svg?token=0r39HNSn84)](https://codecov.io/gh/predyprotocol/contracts)

Predy is an option-specific AMM protocol.

## Documentation

![conracts](https://user-images.githubusercontent.com/81557479/134630527-770a7989-fe3d-46a0-9947-251a5739c8d9.png)

### Contracts

OptionVaults.sol manages Option series and Vaults of both trader and AMM.

AMM.sol manages liquidity that LP provides, and also calculates IV moves and premium for traders to buy or sell options.

### Users

- Trader trades options
- Liquidity Provider provides USDC into pool
- Operator operates creating option series and settle AMM's vaults
- Hedger helps making vaults delta neutral by trading underlying assets in spot market
- Liquidator buys options from AMM and liquidate vaults whose collateral is less than maintenance margin.

### Decimals

|  Name  |  Decimals  |
| ---- | ---- |
|  Option Token  |  8  |
|  LP Token  |  6  |

## Development

run `npm install` to install dependencies.

### Run unit tests

```
npm test
```

