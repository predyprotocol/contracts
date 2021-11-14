import { ethers } from 'hardhat'
import { expect } from 'chai'
import {
  AMMFactory,
  MockERC20,
  MockWETH,
  MockFeePool,
  OptionVaultFactory,
  PriceOracle,
  MockChainlinkAggregator,
  MockLendingPool,
} from '../typechain'
import { constants, Wallet } from 'ethers'
import { scaledBN } from './utils/helpers'

describe('AMMFactory', function () {
  let wallet: Wallet, other: Wallet
  let weth: MockWETH
  let usdc: MockERC20
  let aggregator: MockChainlinkAggregator
  let priceOracle: PriceOracle
  let usdcFeePool: MockFeePool
  let ammFactory: AMMFactory
  let optionVaultFactory: OptionVaultFactory
  let optionLib: any
  let ammLib: any
  let lendingPool: MockLendingPool

  before(async () => {
    ;[wallet, other] = await (ethers as any).getSigners()
    const MockERC20 = await ethers.getContractFactory('MockERC20')
    const MockWETH = await ethers.getContractFactory('MockWETH')
    weth = (await MockWETH.deploy('WETH', 'WETH', 18)) as MockWETH
    usdc = (await MockERC20.deploy('USDC', 'USDC', 6)) as MockERC20

    // mint 50 ETH
    const testAmount = scaledBN(50, 18)
    await weth.deposit({ value: testAmount })

    const MockChainlinkAggregator = await ethers.getContractFactory('MockChainlinkAggregator')
    aggregator = (await MockChainlinkAggregator.deploy()) as MockChainlinkAggregator

    const PriceCalculator = await ethers.getContractFactory('PriceCalculator')
    const priceCalculator = await PriceCalculator.deploy()

    const OptionLib = await ethers.getContractFactory('OptionLib', {
      libraries: {
        PriceCalculator: priceCalculator.address,
      },
    })
    optionLib = await OptionLib.deploy()

    const AMMLib = await ethers.getContractFactory('AMMLib', {
      libraries: {
        PriceCalculator: priceCalculator.address,
      },
    })
    ammLib = await AMMLib.deploy()

    const PriceOracle = await ethers.getContractFactory('PriceOracle')
    priceOracle = (await PriceOracle.deploy()) as PriceOracle
    await priceOracle.setAggregator(aggregator.address)

    const MockFeePool = await ethers.getContractFactory('MockFeePool')
    usdcFeePool = (await MockFeePool.deploy(usdc.address)) as MockFeePool

    const MockLendingPool = await ethers.getContractFactory('MockLendingPool')
    lendingPool = (await MockLendingPool.deploy(usdc.address, weth.address)) as MockLendingPool
  })

  beforeEach(async () => {
    const OptionVaultFactory = await ethers.getContractFactory('OptionVaultFactory', {
      libraries: {
        OptionLib: optionLib.address,
      },
    })

    const AMMFactory = await ethers.getContractFactory('AMMFactory', {
      libraries: {
        AMMLib: ammLib.address,
      },
    })

    optionVaultFactory = (await OptionVaultFactory.deploy(usdc.address, priceOracle.address)) as OptionVaultFactory

    ammFactory = (await AMMFactory.deploy(
      usdc.address,
      wallet.address,
      usdcFeePool.address,
      priceOracle.address,
      optionVaultFactory.address,
    )) as AMMFactory
  })

  describe('createPair', () => {
    it('create vault and pool pair with hedge contract', async () => {
      await optionVaultFactory.setAMMFactoryAddress(ammFactory.address)

      await expect(
        ammFactory.createVaultAndAMM('URI', 'lpTokenURI', aggregator.address, weth.address, lendingPool.address),
      ).to.emit(ammFactory, 'PairCreated')

      const pair = await ammFactory.pairs(0)

      expect(pair.amm).not.to.be.eq(constants.AddressZero)
      expect(pair.optionVault).not.to.be.eq(constants.AddressZero)
    })
  })
})
