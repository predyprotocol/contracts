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

describe('ivmove', function () {
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

  /**
   * check the constraint of tick balance
   * constraint: sum of tick balance == balance of AMM contract
   * @param lowerTick
   * @param upperTick
   */
  async function checkTickBalanceIsValid(lowerTick: number, upperTick: number) {
    const ticks = await amm.getTicks(lowerTick, upperTick)

    const balance = await usdc.balanceOf(amm.address)
    const totalBalance = ticks.reduce((acc, i) => i.balance.add(acc), BigNumber.from(0))

    const lives = await optionVault.getLiveOptionSerieses()

    let cumulativeFee = BigNumber.from(0)

    for (let i = lowerTick; i < upperTick; i++) {
      for (let s of lives) {
        let profitState = await amm.getProfitState(i, s.expiryId)
        cumulativeFee = cumulativeFee.add(profitState.cumulativeFee)
      }
    }
    expect(totalBalance.add(cumulativeFee), 'sum of balance eq to contract balance').to.be.eq(balance)
  }

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
    // check tick state
    await checkTickBalanceIsValid(5, 20)

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

    it('sell premium is less than buy premium if large amount is unlocked', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(2000, 6)
      const minFee = scaledBN(0, 6)

      await testContractHelper.updateSpot(scaledBN(1665, 8))

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId1, amount, maxFee)

      await increaseTime(60 * 60 * 2)

      await testContractHelper.updateSpot(scaledBN(950, 8))

      const premium1 = await testContractHelper.sell(seriesId1, amount, minFee, wallet)

      const premium2 = await testContractHelper.buy(seriesId1, amount, maxFee)

      // assertions
      expect(premium1).to.be.lte(premium2)
    })

    it('sell premium is less than buy premium if large amount is deposited', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(2000, 6)
      const minFee = scaledBN(0, 6)

      await testContractHelper.updateSpot(scaledBN(1000, 8))

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId1, amount, maxFee)

      await increaseTime(60 * 60 * 2)

      const premium1 = await testContractHelper.sell(seriesId1, amount, minFee, wallet)

      const depositAmount = scaledBN(50000, 6)
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, 10, 11)

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId1, scaledBN(1, 1), maxFee)
      const premium2 = await testContractHelper.buy(seriesId1, amount, maxFee)

      // assertions
      expect(premium1).to.be.lte(premium2)
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

    it('buy premium is greater than sell premium if large amount is unlocked', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(2000, 6)
      const minFee = scaledBN(0, 6)

      await testContractHelper.updateSpot(scaledBN(1665, 8))

      const vaultId = await testContractHelper.createAccount(wallet)
      const collateral = scaledBN(2000, 6)

      await testContractHelper.makeShortPosition(vaultId, expiryId, seriesId1, amount, collateral, wallet)

      await increaseTime(60 * 60 * 2)

      await testContractHelper.updateSpot(scaledBN(950, 8))

      await usdc.approve(amm.address, maxFee)
      const premium1 = await testContractHelper.buy(seriesId1, amount, maxFee)

      const premium2 = await testContractHelper.sell(seriesId1, amount, minFee, wallet)

      // assertions
      expect(premium1).to.be.gte(premium2)
    })

    it('buy premium is greater than sell premium if large amount is deposited', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(2000, 6)
      const minFee = scaledBN(0, 6)

      await testContractHelper.updateSpot(scaledBN(1000, 8))

      const vaultId = await testContractHelper.createAccount(wallet)
      const collateral = scaledBN(1000, 6)

      await testContractHelper.makeShortPosition(vaultId, expiryId, seriesId1, amount, collateral, wallet)

      await increaseTime(60 * 60 * 2)

      const depositAmount = scaledBN(50000, 6)
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, 9, 10)

      await usdc.approve(amm.address, maxFee)
      const premium1 = await testContractHelper.buy(seriesId1, amount, maxFee)

      await testContractHelper.sell(seriesId1, scaledBN(1, 1), minFee, wallet)
      const premium2 = await testContractHelper.sell(seriesId1, amount.sub(scaledBN(1, 1)), minFee, wallet)

      // assertions
      expect(premium1).to.be.gte(premium2)
    })
  })
})
