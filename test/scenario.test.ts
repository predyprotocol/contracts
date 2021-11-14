import { ethers } from 'hardhat'
import { expect } from 'chai'
import { OptionVault } from '../typechain/OptionVault'
import { AMM } from '../typechain/AMM'
import { MockERC20, MockFeePool } from '../typechain'
import { BigNumber, Wallet } from 'ethers'
import { genRangeId, getExpiry, increaseTime, scaledBN, setTime } from './utils/helpers'
import { DISPUTE_PERIOD, EXTENSION_PERIOD, MarginLevel, OptionVaultConfig } from './constants'
import {
  deployTestContractSet,
  restoreSnapshot,
  takeSnapshot,
  TestContractHelper,
  TestContractSet,
} from './utils/deploy'

describe('scenario', function () {
  let lpWallet: Wallet, trader: Wallet, liquidator: Wallet, hedger: Wallet
  let weth: MockERC20
  let usdc: MockERC20
  let usdcFeePool: MockFeePool
  let optionVault: OptionVault
  let amm: AMM
  let testContractSet: TestContractSet
  let testContractHelper: TestContractHelper
  let snapshotId: number

  const initialSpot = scaledBN(1000, 8)

  async function hedge(tickId: number, expiryId: BigNumber, price: BigNumber) {
    const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId)
    const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId)
    const netDelta = tickDelta.add(hedgePosition)

    if (netDelta.eq(0)) {
      return 0
    }

    if (netDelta.isNegative()) {
      const longSize = netDelta.abs()

      await weth.connect(hedger).approve(optionVault.address, longSize.mul(scaledBN(1, 10)))
      await optionVault
        .connect(hedger)
        .addUnderlyingLong(tickId, expiryId, longSize, longSize.mul(price).div(scaledBN(1, 10)))
    } else {
      const shortSize = netDelta.abs()

      const usdcAmount = shortSize.mul(price).div(scaledBN(1, 10))
      await usdc.connect(hedger).approve(optionVault.address, usdcAmount)
      await optionVault.connect(hedger).addUnderlyingShort(tickId, expiryId, shortSize, usdcAmount)
    }
  }

  before(async () => {
    ;[lpWallet, trader, liquidator, hedger] = await (ethers as any).getSigners()

    testContractSet = await deployTestContractSet(lpWallet)
    testContractHelper = new TestContractHelper(testContractSet)

    weth = testContractSet.weth
    usdc = testContractSet.usdc
    optionVault = testContractSet.optionVault
    amm = testContractSet.amm
    usdcFeePool = testContractSet.usdcFeePool

    await testContractHelper.updateSpot(initialSpot)
  })

  beforeEach(async () => {
    snapshotId = await takeSnapshot()

    // mint 50 ETH
    const testAmount = scaledBN(50, 18)
    await weth.deposit({ value: testAmount })
    await weth.connect(hedger).deposit({ value: testAmount })

    // mint 100k USDC
    const testUsdcAmount = scaledBN(100000, 6)
    await usdc.mint(lpWallet.address, testUsdcAmount)

    await usdc.mint(trader.address, testUsdcAmount)

    await usdc.mint(liquidator.address, testUsdcAmount)

    await usdc.mint(hedger.address, testUsdcAmount)

    await optionVault.setConfig(OptionVaultConfig.MIN_SIZE, scaledBN(1, 8))
  })

  afterEach(async () => {
    await restoreSnapshot(snapshotId)
  })

  describe('scenario', () => {
    const mintAmount = scaledBN(80000, 6)
    const depositAmount = scaledBN(80000, 6)
    const tickLower = 8
    const tickUpper = 12
    const rangeId = genRangeId(tickLower, tickUpper)
    let expiry28: number
    let expiryId: BigNumber
    let callIds: BigNumber[] = []
    let putIds: BigNumber[] = []
    let beforeBalance: BigNumber

    async function checkBalance() {
      const balanceOfTrader = await usdc.balanceOf(trader.address)
      const balanceOfLP = await usdc.balanceOf(lpWallet.address)
      const balanceOfFeePool = await usdc.balanceOf(usdcFeePool.address)
      const balanceOfLiquidator = await usdc.balanceOf(liquidator.address)

      console.log(
        'trader',
        balanceOfTrader.toString(),
        'LP',
        balanceOfLP.toString(),
        'Liquidator',
        balanceOfLiquidator.toString(),
        'FeePool',
        balanceOfFeePool.toString(),
      )
      return balanceOfTrader.add(balanceOfLP).add(balanceOfLiquidator).add(balanceOfFeePool)
    }

    beforeEach(async () => {
      beforeBalance = await checkBalance()
      const iv = scaledBN(100, 6)

      expiry28 = await getExpiry(28)
      const result = await testContractHelper.createSeriesSet(expiry28, iv)
      expiryId = result.expiryId
      callIds = result.calls
      putIds = result.puts

      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(mintAmount, depositAmount, tickLower, tickUpper)

      const maxFee = scaledBN(1000, 6)
      await usdc.connect(trader).approve(amm.address, maxFee.mul(24))

      // buy call options
      for (let id of callIds) {
        await amm.connect(trader).buy(id, scaledBN(3, 8), maxFee)
      }

      // buy put options
      for (let id of putIds) {
        await amm.connect(trader).buy(id, scaledBN(2, 8), maxFee)
      }
    })

    it('trades and settle', async () => {
      await testContractHelper.updateSpot(scaledBN(1030, 8))

      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, scaledBN(1050, 8))
      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId)

      const w = await amm.getWithdrawableAmount(mintAmount, tickLower, tickUpper)
      await amm.withdraw(mintAmount, w, rangeId, false)

      for (let id of callIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      for (let id of putIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      const afterBalance = await checkBalance()
      expect(afterBalance.sub(beforeBalance)).to.be.lte(0)
      expect(afterBalance.sub(beforeBalance)).to.be.gt(-10)
    })

    it('trader makes short position', async () => {
      await testContractHelper.updateSpot(scaledBN(1030, 8))

      const vaultId = await testContractHelper.createAccount(trader)

      await testContractHelper.makeShortPosition(
        vaultId,
        expiryId,
        callIds[0],
        scaledBN(4, 8),
        scaledBN(2000, 6),
        trader,
      )

      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, scaledBN(1050, 8))
      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId)

      const w = await amm.getWithdrawableAmount(mintAmount, tickLower, tickUpper)
      await amm.withdraw(mintAmount, w, rangeId, false)

      await optionVault.connect(trader).settleVault(vaultId, expiryId)

      for (let id of callIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      for (let id of putIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      const afterBalance = await checkBalance()
      expect(afterBalance.sub(beforeBalance)).to.be.lte(0)
      expect(afterBalance.sub(beforeBalance)).to.be.gt(-10)
    })

    it('trader makes short and long position', async () => {
      await testContractHelper.updateSpot(scaledBN(1030, 8))

      const vaultId = await testContractHelper.createAccount(trader)

      await testContractHelper.makeShortPosition(
        vaultId,
        expiryId,
        callIds[0],
        scaledBN(4, 8),
        scaledBN(2000, 6),
        trader,
      )

      await increaseTime(60 * 60)
      await testContractHelper.updateSpot(scaledBN(1036, 8))

      const maxFee = scaledBN(1000, 6)
      await usdc.connect(trader).approve(amm.address, maxFee)
      await amm.connect(trader).buy(callIds[0], scaledBN(1, 8), maxFee)

      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, scaledBN(1050, 8))
      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId)

      const w = await amm.getWithdrawableAmount(mintAmount, tickLower, tickUpper)
      await amm.withdraw(mintAmount, w, rangeId, false)

      await optionVault.connect(trader).settleVault(vaultId, expiryId)

      for (let id of callIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      for (let id of putIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }
      const afterBalance = await checkBalance()
      expect(afterBalance.sub(beforeBalance)).to.be.lte(0)
      expect(afterBalance.sub(beforeBalance)).to.be.gt(-10)
    })

    it('trader makes short call and put position', async () => {
      await testContractHelper.updateSpot(scaledBN(1030, 8))

      const vaultId = await testContractHelper.createAccount(trader)
      await testContractHelper.makeShortPosition(
        vaultId,
        expiryId,
        callIds[0],
        scaledBN(4, 8),
        scaledBN(2000, 6),
        trader,
      )

      await increaseTime(60 * 60)

      await testContractHelper.makeShortPosition(
        vaultId,
        expiryId,
        putIds[0],
        scaledBN(4, 8),
        scaledBN(2000, 6),
        trader,
      )

      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, scaledBN(1050, 8))
      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId)

      const w = await amm.getWithdrawableAmount(mintAmount, tickLower, tickUpper)
      await amm.withdraw(mintAmount, w, rangeId, false)

      await optionVault.connect(trader).settleVault(vaultId, expiryId)

      for (let id of callIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      for (let id of putIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }
      const afterBalance = await checkBalance()
      expect(afterBalance.sub(beforeBalance)).to.be.lte(0)
      expect(afterBalance.sub(beforeBalance)).to.be.gt(-10)
    })

    it("trader's vault is insolvency", async () => {
      await testContractHelper.updateSpot(scaledBN(1030, 8))

      const vaultId = await testContractHelper.createAccount(trader)
      const minColat = await optionVault.calRequiredMarginForASeries(putIds[1], scaledBN(1, 8), MarginLevel.Initial)

      await usdc.connect(trader).approve(optionVault.address, minColat)
      await optionVault
        .connect(trader)
        .depositAndWrite(vaultId, putIds[1], scaledBN(1, 6), scaledBN(1, 8), trader.address)

      await optionVault.connect(trader).setApprovalForAll(amm.address, true)
      await amm.connect(trader).sell(putIds[1], scaledBN(1, 8), 0)

      await testContractHelper.updateSpot(scaledBN(800, 8))

      console.log(1)
      await usdc.connect(liquidator).approve(amm.address, scaledBN(1000, 6))
      await amm.connect(liquidator).buy(putIds[1], scaledBN(1, 8), scaledBN(1000, 6))
      console.log(2)
      await optionVault.connect(liquidator).liquidate(vaultId, putIds[1], scaledBN(1, 8))
      console.log(3)

      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, scaledBN(1020, 8))
      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId)

      const w = await amm.getWithdrawableAmount(mintAmount, tickLower, tickUpper)
      await amm.withdraw(mintAmount, w, rangeId, false)

      for (let id of callIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      for (let id of putIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      const vault = await optionVault.getVault(vaultId, expiryId)
      if (vault.collateral.gt(0)) {
        await optionVault.connect(trader).withdraw(vaultId, expiryId, vault.collateral)
      }

      // check contract's balance is almost 0
      const afterBalance = await checkBalance()
      expect(afterBalance.sub(beforeBalance)).to.be.lte(0)
      expect(afterBalance.sub(beforeBalance)).to.be.gt(-10)
    })

    it("pool's vault will not be danger by hedged funds", async () => {
      async function hedgeTicks(price: BigNumber) {
        for (let i = tickLower; i <= tickUpper; i++) {
          await hedge(i, expiryId, price)
        }
      }

      const price1 = scaledBN(1030, 8)
      await testContractHelper.updateSpot(price1)

      await hedgeTicks(price1)

      const price2 = scaledBN(1300, 8)
      await testContractHelper.updateSpot(price2)

      await hedgeTicks(price2)

      const price3 = scaledBN(1750, 8)
      await testContractHelper.updateSpot(price3)

      await hedgeTicks(price3)

      const price4 = scaledBN(1900, 8)
      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, price4)
      await increaseTime(DISPUTE_PERIOD)

      await hedgeTicks(price4)

      await amm.settle(expiryId)

      await increaseTime(EXTENSION_PERIOD)

      const w = await amm.getWithdrawableAmount(mintAmount, tickLower, tickUpper)
      await amm.withdraw(mintAmount, w, rangeId, false)

      for (let id of callIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      for (let id of putIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      const balanceOfOptionVault = await usdc.balanceOf(optionVault.address)
      expect(balanceOfOptionVault).to.be.eq(0)

      const balanceOfAMM = await usdc.balanceOf(amm.address)
      expect(balanceOfAMM).to.be.eq(0)

      const afterBalance = await checkBalance()
      expect(afterBalance.sub(beforeBalance)).to.be.gt(0)
    })

    it("pool's vault is insolvency", async () => {
      await testContractHelper.updateSpot(scaledBN(1030, 8))
      await testContractHelper.updateSpot(scaledBN(1750, 8))

      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, scaledBN(3000, 8))
      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId)

      await increaseTime(EXTENSION_PERIOD)

      const w = await amm.getWithdrawableAmount(mintAmount, tickLower, tickUpper)
      await amm.withdraw(mintAmount, w, rangeId, false)

      for (let id of callIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      for (let id of putIds) {
        const balance = await optionVault.balanceOf(trader.address, id)
        await optionVault.connect(trader).claim(id, balance)
      }

      const balanceOfOptionVault = await usdc.balanceOf(optionVault.address)
      expect(balanceOfOptionVault).to.be.eq(0)

      const afterBalance = await checkBalance()
      expect(afterBalance.sub(beforeBalance)).to.be.eq(0)
    })
  })
})
