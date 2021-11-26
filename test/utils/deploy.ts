import { BigNumber, BigNumberish, Wallet } from 'ethers'
import { ethers } from 'hardhat'
import {
  AMM,
  MockChainlinkAggregator,
  MockERC20,
  MockFeePool,
  MockWETH,
  OptionVault,
  PriceOracle,
  MockLendingPool,
} from '../../typechain'
import { MarginLevel } from '../constants'
import { div, scaledBN } from './helpers'

export type TestContractSet = {
  optionVault: OptionVault
  amm: AMM
  priceOracle: PriceOracle
  aggregator: MockChainlinkAggregator
  usdcFeePool: MockFeePool
  weth: MockWETH
  usdc: MockERC20
}

/**
 * contract helper
 */
export class TestContractHelper {
  testContractSet: TestContractSet

  constructor(testContractSet: TestContractSet) {
    this.testContractSet = testContractSet
  }

  async updateRoundData(roundId: number, spot: BigNumberish) {
    await this.testContractSet.aggregator.setLatestRoundData(roundId, spot)
  }

  async updateSpot(spot: BigNumberish) {
    await this.updateRoundData(0, spot)
  }

  async updateExpiryPrice(expiry: number, price: BigNumber) {
    const roundId = 1
    await this.updateRoundData(roundId, price)
    await this.testContractSet.priceOracle.setExpiryPrice(this.testContractSet.aggregator.address, expiry)
  }

  async createSeries(expiry: number, strike: BigNumber, iv: BigNumber) {
    const result = await this.createExpiry(expiry, [strike], [iv])

    return {
      expiryId: result.expiryId,
      call: result.calls[0],
      put: result.puts[0],
    }
  }

  async createSeriesSet(expiry: number, iv?: BigNumber, _numOfStrike?: number) {
    const initialIV = iv || scaledBN(50, 6)
    const numOfStrike = _numOfStrike || 3
    const strikes = []
    const ivs = []

    for (let i = 0; i < numOfStrike; i++) {
      strikes.push(scaledBN(955 + numOfStrike * 50, 8))
      ivs.push(initialIV)
    }

    return await this.createExpiry(expiry, strikes, ivs)
  }

  async createExpiry(expiry: number, strikes: BigNumber[], ivs: BigNumber[]) {
    const tx = await this.testContractSet.optionVault.createExpiry(expiry, strikes, ivs, ivs)

    const receipt = await tx.wait()
    const events = receipt.events?.filter((x) => x.event === 'SeriesCreated')

    const expiryCreatedEvents = receipt.events?.filter((x) => x.event === 'ExpiryCreated')
    const expiryId = expiryCreatedEvents?.map((e) => e.args?.expiryId)[0]

    return {
      expiryId,
      calls: events?.filter((e) => !e.args?.isPut).map((e) => e.args?.seriesId) as BigNumber[],
      puts: events?.filter((e) => e.args?.isPut).map((e) => e.args?.seriesId) as BigNumber[],
    }
  }

  async getIV(seriesId: BigNumber) {
    const series = await this.testContractSet.optionVault.getOptionSeries(seriesId)
    return series.iv
  }

  async getTickDelta(tickId: number, expiryId: BigNumber) {
    return await this.testContractSet.optionVault.calculateVaultDelta(tickId, expiryId)
  }

  async getHedgePosition(tickId: number, expiryId: BigNumber) {
    const vault = await this.testContractSet.optionVault.getVault(tickId, expiryId)
    return vault.hedgePosition
  }

  async getVault(tickId: number, expiryId: BigNumber) {
    return await this.testContractSet.optionVault.getVault(tickId, expiryId)
  }

  async buy(seriesId: BigNumber, amount: BigNumber, maxFee: BigNumber) {
    const tx = await this.testContractSet.amm.buy(seriesId, amount, maxFee)
    const receipt = await tx.wait()
    return receipt.events?.filter((x) => x.event === 'OptionBought')[0].args?.premium
  }

  async sell(seriesId: BigNumber, amount: BigNumber, maxFee: BigNumberish, wallet: Wallet) {
    const tx = await this.testContractSet.amm.connect(wallet).sell(seriesId, amount, maxFee)
    const receipt = await tx.wait()
    return receipt.events?.filter((x) => x.event === 'OptionSold')[0].args?.premium
  }

  async makeShortPosition(
    accountId: number,
    expiryId: BigNumber,
    seriesId: BigNumber,
    shortAmount: BigNumber,
    collateral: BigNumber,
    wallet: Wallet,
  ) {
    // deposit usdc to the vault
    await this.testContractSet.usdc.connect(wallet).approve(this.testContractSet.optionVault.address, collateral)

    const im = await this.testContractSet.optionVault.calRequiredMarginForASeries(
      seriesId,
      shortAmount,
      MarginLevel.Initial,
    )

    const cRatio = div(im.mul(scaledBN(1, 6)), collateral, true)
    const maxCRatio = scaledBN(1, 6)
    const tx = await this.testContractSet.optionVault
      .connect(wallet)
      .makeShortPosition(accountId, seriesId, cRatio.lte(maxCRatio) ? cRatio : maxCRatio, shortAmount, 0)

    const receipt = await tx.wait()

    const events = receipt.events
      ?.filter((x) => x.address === this.testContractSet.amm.address)
      .map((log) => this.testContractSet.amm.interface.decodeEventLog('OptionSold', log.data, log.topics))

    if (events) {
      return events[0].premium
    } else {
      return 0
    }
  }

  async createAccount(wallet: Wallet) {
    const tx = await this.testContractSet.optionVault.connect(wallet).createAccount()
    const receipt = await tx.wait()
    return receipt.events?.filter((x) => x.event === 'AccountCreated')[0].args?.accountId
  }
}

export async function deployTestContractSet(wallet: Wallet): Promise<TestContractSet> {
  const MockWETH = await ethers.getContractFactory('MockWETH')
  const MockERC20 = await ethers.getContractFactory('MockERC20')

  const weth = (await MockWETH.deploy('WETH', 'WETH', 18)) as MockWETH
  const usdc = (await MockERC20.deploy('USDC', 'USDC', 6)) as MockERC20

  const MockChainlinkAggregator = await ethers.getContractFactory('MockChainlinkAggregator')
  const aggregator = (await MockChainlinkAggregator.deploy()) as MockChainlinkAggregator

  const PriceCalculator = await ethers.getContractFactory('PriceCalculator')
  const priceCalculator = await PriceCalculator.deploy()

  const OptionLib = await ethers.getContractFactory('OptionLib', {
    libraries: {
      PriceCalculator: priceCalculator.address,
    },
  })
  const optionLib = await OptionLib.deploy()

  const AMMLib = await ethers.getContractFactory('AMMLib', {
    libraries: {
      PriceCalculator: priceCalculator.address,
    },
  })
  const ammLib = await AMMLib.deploy()

  const PriceOracle = await ethers.getContractFactory('PriceOracle')
  const priceOracle = (await PriceOracle.deploy()) as PriceOracle
  await priceOracle.setAggregator(aggregator.address)

  const MockFeePool = await ethers.getContractFactory('MockFeePool')
  const usdcFeePool = (await MockFeePool.deploy(usdc.address)) as MockFeePool

  const MockLendingPool = await ethers.getContractFactory('MockLendingPool')
  const lendingPool = (await MockLendingPool.deploy(usdc.address, weth.address)) as MockLendingPool

  await weth.mint(lendingPool.address, scaledBN(10, 18))

  const OptionVault = await ethers.getContractFactory('OptionVault', {
    libraries: {
      OptionLib: optionLib.address,
    },
  })

  const AMM = await ethers.getContractFactory('AMM', {
    libraries: {
      AMMLib: ammLib.address,
    },
  })

  const optionVault = (await OptionVault.deploy(
    '',
    aggregator.address,
    usdc.address,
    weth.address,
    priceOracle.address,
    wallet.address,
    lendingPool.address,
  )) as OptionVault

  const amm = (await AMM.deploy(
    '',
    aggregator.address,
    usdc.address,
    priceOracle.address,
    usdcFeePool.address,
    wallet.address,
    optionVault.address,
  )) as AMM

  await optionVault.setAMMAddress(amm.address)

  return {
    amm,
    optionVault,
    weth,
    usdc,
    priceOracle,
    aggregator,
    usdcFeePool,
  }
}

export function send(method: string, params?: Array<any>) {
  return ethers.provider.send(method, params === undefined ? [] : params)
}

export function mineBlock() {
  return send('evm_mine', [])
}

/**
 * take a snapshot and return id
 * @returns snapshot id
 */
export async function takeSnapshot(): Promise<number> {
  const result = await send('evm_snapshot')
  await mineBlock()
  return result
}

/**
 * restore snapshot by id
 * @param id snapshot id
 */
export async function restoreSnapshot(id: number) {
  await send('evm_revert', [id])
  await mineBlock()
}
