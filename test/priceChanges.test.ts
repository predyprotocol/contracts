import { ethers } from 'hardhat'
import { expect } from 'chai'
import { AMM, MockERC20, OptionVault } from '../typechain'
import { BigNumber, Wallet } from 'ethers'
import { getExpiry, increaseTime, scaledBN } from './utils/helpers'
import {
  deployTestContractSet,
  restoreSnapshot,
  takeSnapshot,
  TestContractHelper,
  TestContractSet,
} from './utils/deploy'

describe('priceChanges', function () {
  let wallet: Wallet, other: Wallet
  let weth: MockERC20
  let usdc: MockERC20
  let optionVault: OptionVault
  let amm: AMM
  let testContractSet: TestContractSet
  let testContractHelper: TestContractHelper
  let snapshotId: number
  let beforeFeePoolBalance: BigNumber
  const initialSpot = scaledBN(1000, 8)

  before(async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    testContractSet = await deployTestContractSet(wallet)
    testContractHelper = new TestContractHelper(testContractSet)

    weth = testContractSet.weth
    usdc = testContractSet.usdc
    amm = testContractSet.amm
    optionVault = testContractSet.optionVault
  })

  beforeEach(async () => {
    snapshotId = await takeSnapshot()
    // mint 100 ETH
    const testAmount = scaledBN(100, 18)
    await weth.mint(wallet.address, testAmount)
    // mint 100 USDC
    const testUsdcAmount = scaledBN(100000, 6)
    await usdc.mint(wallet.address, testUsdcAmount)
    await usdc.mint(other.address, testUsdcAmount)

    await testContractHelper.updateSpot(initialSpot)

    beforeFeePoolBalance = await usdc.balanceOf(testContractSet.usdcFeePool.address)
  })

  afterEach(async () => {
    await restoreSnapshot(snapshotId)
  })

  describe('short ticks', () => {
    let expiryId: BigNumber
    let seriesId1: BigNumber
    let seriesId2: BigNumber
    const depositAmount = scaledBN(8000, 6)
    const lower = 8
    const upper = 12

    beforeEach(async () => {
      const expiry = await getExpiry(28)
      const strike1 = scaledBN(1000, 8)
      const strike2 = scaledBN(1200, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike1, strike2], [iv, iv])

      expiryId = result.expiryId
      seriesId1 = result.calls[0]
      seriesId2 = result.calls[1]

      // deposit
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, lower, upper)
    })

    it('sell premium is less than buy premium if oracle price changes largely', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(2000, 6)
      const minFee = scaledBN(0, 6)

      await testContractHelper.updateSpot(scaledBN(1001, 8))

      await usdc.approve(amm.address, maxFee)
      const premium1 = await testContractHelper.buy(seriesId1, amount, maxFee)

      await testContractHelper.updateSpot(scaledBN(1020, 8))

      const premium2 = await testContractHelper.sell(seriesId1, amount, minFee, wallet)

      // assertions
      expect(premium1).to.be.gte(premium2)
    })

    it('price affected after safety period', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(2000, 6)
      const minFee = scaledBN(0, 6)

      await testContractHelper.updateSpot(scaledBN(1001, 8))

      await usdc.approve(amm.address, maxFee)
      const premium1 = await testContractHelper.buy(seriesId1, amount, maxFee)

      await testContractHelper.updateSpot(scaledBN(1020, 8))

      // 10 minutes passed
      await increaseTime(60 * 10)

      const premium2 = await testContractHelper.sell(seriesId1, amount, minFee, wallet)

      // assertions
      expect(premium1).to.be.lt(premium2)
    })
  })

  describe('long ticks', () => {
    let expiryId: BigNumber
    let seriesId1: BigNumber
    let seriesId2: BigNumber
    const depositAmount = scaledBN(12000, 6)
    const lower = 8
    const upper = 12

    beforeEach(async () => {
      const expiry = await getExpiry(28)
      const strike1 = scaledBN(1000, 8)
      const strike2 = scaledBN(1200, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike1, strike2], [iv, iv])

      expiryId = result.expiryId
      seriesId1 = result.calls[0]
      seriesId2 = result.calls[1]

      // deposit
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, lower, upper)
    })

    it('buy premium is greater than sell premium if oracle price change largely', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(2000, 6)

      await testContractHelper.updateSpot(scaledBN(1020, 8))

      const vaultId = await testContractHelper.createAccount(wallet)
      const collateral = scaledBN(2000, 6)

      const premium1 = await testContractHelper.makeShortPosition(
        vaultId,
        expiryId,
        seriesId1,
        amount,
        collateral,
        wallet,
      )

      await testContractHelper.updateSpot(scaledBN(1002, 8))

      await usdc.approve(amm.address, maxFee)
      const premium2 = await testContractHelper.buy(seriesId1, amount, maxFee)

      // assertions
      expect(premium1).to.be.lte(premium2)
    })

    it('price affected after safety period', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(2000, 6)

      await testContractHelper.updateSpot(scaledBN(1020, 8))

      const vaultId = await testContractHelper.createAccount(wallet)
      const collateral = scaledBN(2000, 6)

      const premium1 = await testContractHelper.makeShortPosition(
        vaultId,
        expiryId,
        seriesId1,
        amount,
        collateral,
        wallet,
      )

      await increaseTime(60 * 10)

      await testContractHelper.updateSpot(scaledBN(1002, 8))

      await usdc.approve(amm.address, maxFee)
      const premium2 = await testContractHelper.buy(seriesId1, amount, maxFee)

      // assertions
      expect(premium1).to.be.gte(premium2)
    })
  })
})
