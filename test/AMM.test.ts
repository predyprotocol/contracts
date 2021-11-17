import { ethers } from 'hardhat'
import { expect } from 'chai'
import { AMM, MockERC20, OptionVault } from '../typechain'
import { BigNumber, Wallet } from 'ethers'
import { div, genRangeId, getExpiry, increaseTime, scaledBN, setTime } from './utils/helpers'
import { AMMConfig, DISPUTE_PERIOD, LOCKUP_PERIOD } from './constants'
import {
  deployTestContractSet,
  restoreSnapshot,
  takeSnapshot,
  TestContractHelper,
  TestContractSet,
} from './utils/deploy'
import { VaultErrors } from './utils/errors'

describe('AMM', function () {
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

  async function makeShortPosition(
    vaultId: number,
    expiryId: BigNumber,
    seriesId: BigNumber,
    shortAmount: BigNumber,
    collateral: BigNumber,
    wallet: Wallet,
  ) {
    // deposit usdc to the vault
    await usdc.connect(wallet).approve(optionVault.address, collateral)
    await optionVault.connect(wallet).deposit(vaultId, expiryId, collateral)
    await optionVault.connect(wallet).write(vaultId, seriesId, shortAmount, wallet.address)

    // sell options
    const minFee = 0
    await optionVault.connect(wallet).setApprovalForAll(amm.address, true)

    return await testContractHelper.sell(seriesId, shortAmount, minFee, wallet)
  }

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

  async function getIV(seriesId: BigNumber) {
    return await testContractHelper.getIV(seriesId)
  }

  async function getProtocolFee() {
    const afterFeePoolBalance = await usdc.balanceOf(testContractSet.usdcFeePool.address)
    return afterFeePoolBalance.sub(beforeFeePoolBalance)
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

  describe('deposit', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    const depositAmount = scaledBN(5000, 6)
    const tickLower = 10
    const tickUpper = 12

    beforeEach(async () => {
      const expiry = await getExpiry(1)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createSeries(expiry, strike, iv)
      expiryId = result.expiryId
      seriesId = result.call
    })

    it('deposit usdc to AMM', async () => {
      const rangeId = genRangeId(tickLower, tickUpper)

      await usdc.approve(amm.address, depositAmount)
      await expect(amm.deposit(depositAmount, depositAmount, tickLower, tickUpper))
        .to.emit(amm, 'Deposited')
        .withArgs(wallet.address, usdc.address, rangeId, depositAmount, depositAmount)
    })

    it('deposit liquidity after withdrawal', async () => {
      const rangeId = genRangeId(tickLower, tickUpper)

      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, tickLower, tickUpper)

      await increaseTime(LOCKUP_PERIOD + 60)

      // withdraw
      await amm.withdraw(depositAmount, depositAmount, rangeId, false)

      // re-deposit
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, tickLower, tickUpper)
    })

    it('reverts if start is greater than end', async () => {
      const mintAmount = await amm.getMintAmount(depositAmount, tickLower, tickUpper)
      await usdc.approve(amm.address, depositAmount)

      await expect(amm.deposit(mintAmount, depositAmount, tickLower, tickLower)).to.be.revertedWith(
        'AMM: end must be greater than start',
      )

      await expect(amm.deposit(mintAmount, depositAmount, tickUpper, tickLower)).to.be.revertedWith(
        'AMM: end must be greater than start',
      )
    })

    it('reverts if tick is greater than 30', async () => {
      const mintAmount = await amm.getMintAmount(depositAmount, tickLower, tickUpper)
      await usdc.approve(amm.address, depositAmount)

      await expect(amm.deposit(mintAmount, depositAmount, tickLower, 31)).to.be.revertedWith(
        'AMM: tick must be less than MAX',
      )

      await expect(amm.deposit(mintAmount, depositAmount, 31, 32)).to.be.revertedWith('AMM: tick must be less than MAX')
    })

    it('reverts if tick is less than 1', async () => {
      const mintAmount = await amm.getMintAmount(depositAmount, tickLower, tickUpper)
      await usdc.approve(amm.address, depositAmount)

      await expect(amm.deposit(mintAmount, depositAmount, 0, 1)).to.be.revertedWith(
        'AMM: start must be greater than MIN',
      )
    })

    it('reverts if amount is 0', async () => {
      await expect(amm.deposit(0, depositAmount, tickLower, tickUpper)).to.be.revertedWith('AMM: amount is too small')
    })

    it('reverts if deposit amount is greater than max deposit', async () => {
      const mintAmount = await amm.getMintAmount(depositAmount, tickLower, tickUpper)
      await usdc.approve(amm.address, depositAmount)

      await expect(amm.deposit(mintAmount, depositAmount.sub(1), tickLower, tickUpper)).to.be.revertedWith(
        'AMM: amount deposited is greater than max',
      )
    })

    it('reverts if deposit is not allowed', async () => {
      const depositAllowedUntil = await getExpiry(1)

      await amm.setDepositAllowedUntil(depositAllowedUntil)

      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, tickLower, tickUpper)

      await setTime(depositAllowedUntil + 60)

      // no one can deposit after depositAllowedUntil timestamp
      await usdc.approve(amm.address, depositAmount)
      await expect(amm.deposit(depositAmount, depositAmount, tickLower, tickUpper)).to.be.revertedWith(
        'AMM: deposit not allowed',
      )
    })
  })

  describe('reserveWithdrawal', () => {
    const tickLower = 10
    const tickUpper = 12
    const maxDepositAmount = scaledBN(5000, 6)

    beforeEach(async () => {
      const mintAmount = await amm.getMintAmount(maxDepositAmount, tickLower, tickUpper)
      await usdc.approve(amm.address, maxDepositAmount)
      await amm.deposit(mintAmount, maxDepositAmount, tickLower, tickUpper)
    })

    it('reverts if amount is too small', async () => {
      const rangeId = await amm.genRangeId(tickLower, tickUpper)

      await expect(amm.reserveWithdrawal(0, rangeId)).to.be.revertedWith('AMM: amount is too small')
    })

    it('reverts if amount is too large', async () => {
      const rangeId = await amm.genRangeId(tickLower, tickUpper)
      const balance = await amm.balanceOf(wallet.address, rangeId)

      await expect(amm.reserveWithdrawal(balance.add(1), rangeId)).to.be.revertedWith('AMM: amount is too large')
    })

    it('succeed to reserve', async () => {
      const rangeId = await amm.genRangeId(tickLower, tickUpper)
      const balance = await amm.balanceOf(wallet.address, rangeId)

      await amm.reserveWithdrawal(balance, rangeId)
      const reservation = await amm.reservations(wallet.address, rangeId)

      expect(reservation.burn).to.be.eq(balance)
    })

    it('reserve after reserve', async () => {
      const rangeId = await amm.genRangeId(tickLower, tickUpper)
      const balance = await amm.balanceOf(wallet.address, rangeId)

      await amm.reserveWithdrawal(balance.sub(scaledBN(1, 6)), rangeId)
      await amm.reserveWithdrawal(scaledBN(1, 6), rangeId)

      const reservation = await amm.reservations(wallet.address, rangeId)

      expect(reservation.burn).to.be.eq(balance)
    })
  })

  describe('withdraw', () => {
    let expiry1: number
    let expiry28: number
    let expiryId1: BigNumber
    let expiryId28: BigNumber
    let callOptionId1: BigNumber
    let callOptionId28: BigNumber
    const tickLower = 10
    const tickUpper = 12
    const maxDepositAmount = scaledBN(5000, 6)
    const maxFee = scaledBN(1000, 6)
    const strike = scaledBN(1000, 8)

    beforeEach(async () => {
      expiry1 = await getExpiry(1)
      expiry28 = await getExpiry(28)
      const iv = scaledBN(100, 6)

      const createdResult1 = await testContractHelper.createSeries(expiry1, strike, iv)
      const createdResult28 = await testContractHelper.createSeries(expiry28, strike, iv)

      expiryId1 = createdResult1.expiryId
      callOptionId1 = createdResult1.call
      expiryId28 = createdResult28.expiryId
      callOptionId28 = createdResult28.call

      const mintAmount = await amm.getMintAmount(maxDepositAmount, tickLower, tickUpper)
      await usdc.approve(amm.address, maxDepositAmount)
      await amm.deposit(mintAmount, maxDepositAmount, tickLower, tickUpper)
    })

    it('withdraw all', async () => {
      const rangeId = await amm.genRangeId(tickLower, tickUpper)
      const balance = await amm.balanceOf(wallet.address, rangeId)
      const amount = await amm.getWithdrawableAmount(balance, tickLower, tickUpper)

      await increaseTime(LOCKUP_PERIOD + 60)

      // withdraw
      const beforeBalance = await usdc.balanceOf(wallet.address)
      await expect(amm.withdraw(balance, amount, rangeId, false))
        .to.emit(amm, 'Withdrawn')
        .withArgs(wallet.address, usdc.address, rangeId, amount, balance)
      const afterBalance = await usdc.balanceOf(wallet.address)

      expect(afterBalance.sub(beforeBalance)).to.be.eq(amount)
    })

    it('reverts if burnAmount is too large', async () => {
      const rangeId = await amm.genRangeId(tickLower, tickUpper)
      const amountOfLPToken = await amm.balanceOf(wallet.address, rangeId)
      const withdrawAmount = await amm.getWithdrawableAmount(amountOfLPToken, tickLower, tickUpper)

      await expect(amm.withdraw(amountOfLPToken.add(1), withdrawAmount, rangeId, false)).to.be.revertedWith(
        "AMM: msg.sender doesn't have enough LP tokens",
      )
    })

    it('reverts if there is no enough withdrawable amount', async () => {
      const size = scaledBN(1, 8)

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(callOptionId28, size, maxFee)

      const rangeId = await amm.genRangeId(tickLower, tickUpper)
      const amountOfLPToken = await amm.balanceOf(wallet.address, rangeId)
      const withdrawAmount = await amm.getWithdrawableAmount(amountOfLPToken, tickLower, tickUpper)

      await expect(amm.withdraw(amountOfLPToken, withdrawAmount, rangeId, false)).to.be.revertedWith(
        'AMMLib: no enough balance to withdraw',
      )
    })

    it('withdraw after claim', async () => {
      const optionId = callOptionId28
      const amount = scaledBN(1, 8)

      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(optionId, amount, maxFee)

      // settlement
      const spot = scaledBN(1100, 8)
      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, spot)
      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId28)

      // get withdrawable amount
      const rangeId = await amm.genRangeId(tickLower, tickUpper)
      const balance = await amm.balanceOf(wallet.address, rangeId)
      const withdrawAmount = await amm.getWithdrawableAmount(balance, tickLower, tickUpper)

      // withdraw
      const beforeBalance = await usdc.balanceOf(wallet.address)
      await amm.withdraw(balance, withdrawAmount, rangeId, false)
      const afterBalance = await usdc.balanceOf(wallet.address)

      // assertions
      expect(afterBalance.sub(beforeBalance)).to.be.eq(withdrawAmount)
      const payout = amount.mul(spot.sub(strike)).div(scaledBN(1, 10))
      const protocolFee = await getProtocolFee()

      expect(afterBalance.sub(beforeBalance)).to.be.eq(maxDepositAmount.add(premium).sub(payout).sub(protocolFee))
    })

    it('withdraw after settlement', async () => {
      const optionId = callOptionId28
      const amount = scaledBN(1, 8)

      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(optionId, amount, maxFee)

      // settlement
      await setTime(expiry28 + 60)
      await testContractHelper.updateExpiryPrice(expiry28, scaledBN(1000, 8))
      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId28)

      // withdraw
      const rangeId = await amm.genRangeId(tickLower, tickUpper)
      const balance = await amm.balanceOf(wallet.address, rangeId)
      const withdrawAmount = await amm.getWithdrawableAmount(balance, tickLower, tickUpper)

      const beforeBalance = await usdc.balanceOf(wallet.address)
      await amm.withdraw(balance, withdrawAmount, rangeId, false)
      const afterBalance = await usdc.balanceOf(wallet.address)

      // assertions
      expect(afterBalance.sub(beforeBalance)).to.be.eq(withdrawAmount)
      const protocolFee = await getProtocolFee()

      expect(afterBalance.sub(beforeBalance)).to.be.eq(maxDepositAmount.add(premium.sub(protocolFee)))
    })

    describe('use reservation', () => {
      it('reserve and withdraw', async () => {
        const amount = scaledBN(20, 7)

        await usdc.approve(amm.address, maxFee)
        const premium = await testContractHelper.buy(callOptionId28, amount, maxFee)

        // iv is over 110%
        expect(await getIV(callOptionId28)).to.be.gt(110000000)

        const rangeId = await amm.genRangeId(tickLower, tickUpper)
        const lpTokenBalance = await amm.balanceOf(wallet.address, rangeId)

        // reserve withdrawal
        await amm.reserveWithdrawal(lpTokenBalance, rangeId)

        const spot = scaledBN(1150, 8)
        await setTime(expiry28 + 60)
        await testContractHelper.updateExpiryPrice(expiry28, spot)
        await increaseTime(DISPUTE_PERIOD)

        // settlement
        await amm.settle(expiryId28)

        const withdrawAmount = await amm.getWithdrawableAmount(lpTokenBalance, tickLower, tickUpper)
        const beforeBalance = await usdc.balanceOf(wallet.address)

        // withdraw
        await amm.withdraw(lpTokenBalance, withdrawAmount, rangeId, true)
        const afterBalance = await usdc.balanceOf(wallet.address)

        const protocolFee = await getProtocolFee()

        const payout = div(amount.mul(spot.sub(strike)), scaledBN(1, 10), true)

        // assertions
        expect(afterBalance.sub(beforeBalance)).to.be.eq(withdrawAmount)
        expect(afterBalance.sub(beforeBalance)).to.be.eq(maxDepositAmount.add(premium).sub(protocolFee).sub(payout))
      })

      it('reserve if withdrawable period has not passed', async () => {
        const amount = scaledBN(20, 7)

        await usdc.approve(amm.address, maxFee)
        await testContractHelper.buy(callOptionId28, amount, maxFee)

        // iv is over 110%
        expect(await getIV(callOptionId28)).to.be.gt(110000000)

        const rangeId = await amm.genRangeId(tickLower, tickUpper)
        const balance = await amm.balanceOf(wallet.address, rangeId)
        const lpToken = balance.div(2)

        // reserve withdrawal
        await amm.reserveWithdrawal(lpToken, rangeId)

        // withdraw
        const withdrawAmount = await amm.getWithdrawableAmount(lpToken, tickLower, tickUpper)

        await expect(amm.withdraw(lpToken, withdrawAmount, rangeId, true)).to.be.revertedWith(
          'AMM: withdrawable period must have passed',
        )
      })

      it('reverts if there is no reservation', async () => {
        const rangeId = await amm.genRangeId(tickLower, tickUpper)
        const balance = await amm.balanceOf(wallet.address, rangeId)
        const amount = await amm.getWithdrawableAmount(balance, tickLower, tickUpper)

        await expect(amm.withdraw(balance, amount, rangeId, true)).to.be.revertedWith(
          'AMM: burnAmount must be reserved',
        )
      })
    })
  })

  describe('lockup period', () => {
    const tickLower = 10
    const tickUpper = 12
    const maxDepositAmount = scaledBN(5000, 6)
    let rangeId: BigNumber

    beforeEach(async () => {
      rangeId = await amm.genRangeId(tickLower, tickUpper)

      const mintAmount = await amm.getMintAmount(maxDepositAmount, tickLower, tickUpper)
      await usdc.approve(amm.address, maxDepositAmount)
      await amm.deposit(mintAmount, maxDepositAmount, tickLower, tickUpper)
    })

    it('transfer LP tokens by allowed operator', async () => {
      await amm.setAddressAllowedSkippingLockup(other.address, true)

      const balance = await amm.balanceOf(wallet.address, rangeId)

      await amm.setApprovalForAll(other.address, true)
      await amm.connect(other).safeTransferFrom(wallet.address, other.address, rangeId, balance, '0x')
    })

    it('transfer after locked up period', async () => {
      const balance = await amm.balanceOf(wallet.address, rangeId)
      const amount = await amm.getWithdrawableAmount(balance, tickLower, tickUpper)

      await increaseTime(LOCKUP_PERIOD + 60)

      await amm.safeTransferFrom(wallet.address, other.address, rangeId, balance, '0x')

      await amm.connect(other).withdraw(balance, amount, rangeId, false)
    })

    it('withdraw after locked up period', async () => {
      const balance = await amm.balanceOf(wallet.address, rangeId)
      const amount = await amm.getWithdrawableAmount(balance, tickLower, tickUpper)

      await increaseTime(LOCKUP_PERIOD + 60)

      await amm.withdraw(balance, amount, rangeId, false)
    })

    it("reverts if locked up period hasn't been passed", async () => {
      const balance = await amm.balanceOf(wallet.address, rangeId)
      const amount = await amm.getWithdrawableAmount(balance, tickLower, tickUpper)

      // can't withdraw
      await expect(amm.withdraw(balance, amount, rangeId, false)).to.be.revertedWith('AMM: liquidity is locked up')

      // can't transfer
      await expect(amm.safeTransferFrom(wallet.address, other.address, rangeId, balance, '0x')).to.be.revertedWith(
        'AMM: liquidity is locked up',
      )
    })
  })

  describe('getter functions', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    const depositAmount = scaledBN(50000, 6)
    const lower = 10
    const upper = 15

    beforeEach(async () => {
      const expiry = await getExpiry(28)
      const strike = scaledBN(1010, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createSeries(expiry, strike, iv)
      expiryId = result.expiryId
      seriesId = result.call

      // deposit
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, lower, upper)
    })

    describe('calculatePremium', () => {
      it('calculate premium to buy', async () => {
        const amount = scaledBN(9, 7)

        const premium = await amm.calculatePremium(seriesId, amount, false)

        expect(premium).to.be.gt(0)
      })

      it('calculate premium to buy large amount', async () => {
        const amount = scaledBN(11, 8)

        const premium = await amm.calculatePremium(seriesId, amount, false)

        expect(premium).to.be.gt(0)
      })

      it('reverts if amount is too large', async () => {
        const amount = scaledBN(100, 8)

        await expect(amm.calculatePremium(seriesId, amount, false)).to.be.revertedWith('AMMLib: tick is too large')
      })

      describe('selling premium', () => {
        beforeEach(async () => {
          const amount = scaledBN(20, 8)
          const maxFee = scaledBN(6000, 6)

          await usdc.approve(amm.address, maxFee)
          await testContractHelper.buy(seriesId, amount, maxFee)
        })

        it('calculate premium to sell', async () => {
          const amount = scaledBN(9, 7)

          const premium = await amm.calculatePremium(seriesId, amount, true)

          expect(premium).to.be.gt(0)
        })

        it('calculate premium to sell large amount', async () => {
          const amount = scaledBN(198, 7)

          const premium = await amm.calculatePremium(seriesId, amount, true)

          expect(premium).to.be.gt(0)
        })

        it('reverts if amount is too large', async () => {
          const amount = scaledBN(100, 8)

          await expect(amm.calculatePremium(seriesId, amount, true)).to.be.revertedWith('AMMLib: tick is too small')
        })
      })
    })

    describe('getSecondsPerLiquidity', () => {
      it('trade increases second per liquidity', async () => {
        const amount = scaledBN(1, 8)
        const maxFee = scaledBN(6000, 6)

        await usdc.approve(amm.address, maxFee)
        await testContractHelper.buy(seriesId, amount, maxFee)

        const beforeSecPerLiq = await amm.getSecondsPerLiquidity(lower, upper)

        await increaseTime(60 * 60)

        await usdc.approve(amm.address, maxFee)
        await testContractHelper.buy(seriesId, amount, maxFee)

        const afterSecPerLiq = await amm.getSecondsPerLiquidity(lower, upper)

        expect(beforeSecPerLiq).to.be.lt(afterSecPerLiq)
      })
    })
  })

  describe('buy', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    let seriesId2: BigNumber
    const depositAmount = scaledBN(70000, 6)
    const lower = 8
    const upper = 15
    const rangeId = genRangeId(lower, upper)

    beforeEach(async () => {
      const expiry = await getExpiry(28)
      const strike = scaledBN(1010, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike, strike], [iv, scaledBN(90, 6)])

      expiryId = result.expiryId
      seriesId = result.calls[0]
      seriesId2 = result.calls[1]

      // deposit
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, lower, upper)
    })

    it('buy options within a short tick', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(1000, 6)

      const before = await optionVault.balanceOf(wallet.address, seriesId)
      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
      expect(premium).to.be.gt(0)

      await usdc.approve(amm.address, maxFee.mul(10))
      const amount2 = scaledBN(2, 8)
      await testContractHelper.buy(seriesId, amount2, maxFee)
      await testContractHelper.buy(seriesId, amount2, maxFee)
    })

    it('buy small amount', async () => {
      const amount = scaledBN(1, 7)
      const maxFee = scaledBN(1000, 6)

      await usdc.approve(amm.address, maxFee)
      await await testContractHelper.buy(seriesId, amount, maxFee)

      const beforeProfitState = await amm.getProfitState(10, expiryId)

      const before = await optionVault.balanceOf(wallet.address, seriesId)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
      expect(premium).to.be.gt(0)

      // check cumulative fee
      const profitState = await amm.getProfitState(10, expiryId)
      const cumulativeFee = profitState.cumulativeFee.sub(beforeProfitState.cumulativeFee)

      const baseFee = premium.sub(cumulativeFee)

      const expectedCumulativeFee = amount.mul(initialSpot.div(250)).div(scaledBN(1, 10)).add(baseFee.div(100))

      expect(cumulativeFee).to.be.eq(expectedCumulativeFee)
    })

    it('buy options within a long tick', async () => {
      // short position
      const vaultId = await testContractHelper.createAccount(other)
      const collateral = scaledBN(1000, 6)
      const shortAmount = scaledBN(1, 8)
      // deposit usdc to the vault
      await usdc.connect(other).approve(optionVault.address, collateral)
      await optionVault.connect(other).deposit(vaultId, expiryId, collateral)
      await optionVault.connect(other).write(vaultId, seriesId, shortAmount, other.address)

      // sell options
      const minFee = 0
      await optionVault.connect(other).setApprovalForAll(amm.address, true)

      await amm.connect(other).sell(seriesId, shortAmount, minFee)

      // iv is under 100%
      expect(await getIV(seriesId)).to.be.lt(100000000)

      const amount = scaledBN(5, 7)
      const maxFee = scaledBN(1000, 6)

      await usdc.approve(amm.address, maxFee)

      const before = await optionVault.balanceOf(wallet.address, seriesId)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
      expect(premium).to.be.gt(0)
    })

    it('buy options from long tick to short tick', async () => {
      // short position
      const vaultId = await testContractHelper.createAccount(other)
      const collateral = scaledBN(1000, 6)
      const shortAmount = scaledBN(1, 8)
      // deposit usdc to the vault
      await usdc.connect(other).approve(optionVault.address, collateral)
      await optionVault.connect(other).deposit(vaultId, expiryId, collateral)
      await optionVault.connect(other).write(vaultId, seriesId, shortAmount, other.address)

      // sell options
      const minFee = 0
      await optionVault.connect(other).setApprovalForAll(amm.address, true)

      await amm.connect(other).sell(seriesId, shortAmount, minFee)

      const amount = scaledBN(15, 7)
      const maxFee = scaledBN(1000, 6)

      await usdc.approve(amm.address, maxFee)

      const before = await optionVault.balanceOf(wallet.address, seriesId)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
      expect(premium).to.be.gt(0)
    })

    it('buy options from long tick to another long tick', async () => {
      // short position
      const vaultId = await testContractHelper.createAccount(other)
      const collateral = scaledBN(16000, 6)
      const shortAmount = scaledBN(6, 8)
      // deposit usdc to the vault
      await usdc.connect(other).approve(optionVault.address, collateral)
      await optionVault.connect(other).deposit(vaultId, expiryId, collateral)
      await optionVault.connect(other).write(vaultId, seriesId, shortAmount, other.address)

      // sell options
      const minFee = 0
      await optionVault.connect(other).setApprovalForAll(amm.address, true)

      await amm.connect(other).sell(seriesId, shortAmount, minFee)

      // iv is under 90%
      expect(await getIV(seriesId)).to.be.lt(90000000)

      const amount = scaledBN(5, 8)
      const maxFee = scaledBN(1000, 6)

      await usdc.approve(amm.address, maxFee)

      const before = await optionVault.balanceOf(wallet.address, seriesId)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      // iv is over 100%
      expect(await getIV(seriesId)).to.be.gt(90000000)

      expect(after.sub(before)).to.be.eq(amount)
      expect(premium).to.be.gt(0)
    })

    it('buy options from short tick to another short tick', async () => {
      const amount = scaledBN(11, 8)
      const maxFee = scaledBN(10000, 6)

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId, scaledBN(1, 7), maxFee)

      await usdc.approve(amm.address, maxFee)

      const before = await optionVault.balanceOf(wallet.address, seriesId)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
      expect(premium).to.be.gt(0)

      expect(await getIV(seriesId)).to.be.gt(110000000)
    })

    it('buy different options', async () => {
      const amount = scaledBN(11, 8)
      const maxFee = scaledBN(10000, 6)

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId2, scaledBN(11, 8), maxFee)

      await usdc.approve(amm.address, maxFee)

      const before = await optionVault.balanceOf(wallet.address, seriesId)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
      expect(premium).to.be.gt(0)

      expect(await getIV(seriesId2)).to.be.gt(100000000)
      expect(await getIV(seriesId)).to.be.gt(110000000)
    })

    it('buy options after withdrawal', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(1000, 6)
      const withdrawAmount = scaledBN(14000, 6)

      await increaseTime(LOCKUP_PERIOD + 60)

      // withdraw
      await amm.withdraw(withdrawAmount, amount, rangeId, false)

      // buy options
      const before = await optionVault.balanceOf(wallet.address, seriesId)
      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
      expect(premium).to.be.gt(0)
    })

    it('reverts if amount is too large', async () => {
      const amount = scaledBN(100, 8)
      const maxFee = scaledBN(10, 6)

      await usdc.approve(amm.address, maxFee)
      await expect(testContractHelper.buy(seriesId, amount, maxFee)).to.be.revertedWith('AMMLib: tick is too large')
    })

    it('reverts if maxFee is too small', async () => {
      const amount = scaledBN(1, 7)
      const maxFee = scaledBN(10, 6)

      await usdc.approve(amm.address, maxFee)
      await expect(testContractHelper.buy(seriesId, amount, maxFee)).to.be.revertedWith(
        'AMM: total fee exceeds maxFeeAmount',
      )
    })

    it('reverts if amount is 0', async () => {
      const maxFee = scaledBN(1000, 6)

      await expect(amm.buy(seriesId, 0, maxFee)).to.be.revertedWith('AMM: amount must not be 0')
    })

    it('reverts if delta is too low', async () => {
      const amount = scaledBN(1, 7)
      const maxFee = scaledBN(1000, 6)

      // set min delta 10%
      testContractSet.amm.setConfig(AMMConfig.MIN_DELTA, scaledBN(10, 6))

      // seriesId becomes OTM(low delta)
      await testContractHelper.updateSpot(scaledBN(500, 8))

      await usdc.approve(amm.address, maxFee)
      await expect(amm.buy(seriesId, amount, maxFee)).to.be.revertedWith('delta is too low')
    })
  })

  describe('sell', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber

    beforeEach(async () => {
      const expiry = await getExpiry(28)
      const strike = scaledBN(1010, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]

      const depositAmount = scaledBN(75000, 6)
      const lower = 9
      const upper = 12

      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, lower, upper)
    })

    it('close to sell within a short tick', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(1000, 6)

      // buy options
      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)

      const minFee = 0
      await optionVault.setApprovalForAll(amm.address, true)

      // close long position
      const before = await usdc.balanceOf(wallet.address)
      await amm.sell(seriesId, amount, minFee)
      const after = await usdc.balanceOf(wallet.address)

      expect(after.sub(before)).to.be.lt(premium)
    })

    it('close to sell from a short tick to another short tick', async () => {
      const amount = scaledBN(25, 7)
      const maxFee = scaledBN(1000, 6)

      // buy options
      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)

      expect(await getIV(seriesId)).to.be.gt(100000000)

      const minFee = 0
      await optionVault.setApprovalForAll(amm.address, true)

      // close long position
      const sellAmount = scaledBN(20, 7)

      const before = await usdc.balanceOf(wallet.address)
      await amm.sell(seriesId, sellAmount, minFee)
      const after = await usdc.balanceOf(wallet.address)

      expect(await getIV(seriesId)).to.be.gt(100000000)

      expect(after.sub(before)).to.be.lt(premium)
    })

    it('sell options', async () => {
      const amount = scaledBN(20, 8)
      const maxFee = scaledBN(3000, 6)

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId, amount, maxFee)

      // short position
      const vaultId = await testContractHelper.createAccount(other)
      const collateral = scaledBN(1000, 6)
      const shortAmount = scaledBN(1, 8)
      // deposit usdc to the vault
      await usdc.connect(other).approve(optionVault.address, collateral)
      await optionVault.connect(other).deposit(vaultId, expiryId, collateral)
      await optionVault.connect(other).write(vaultId, seriesId, shortAmount, other.address)

      // sell options
      const minFee = 0
      await optionVault.connect(other).setApprovalForAll(amm.address, true)

      const before = await usdc.balanceOf(other.address)
      await amm.connect(other).sell(seriesId, shortAmount, minFee)
      const after = await usdc.balanceOf(other.address)

      expect(after.sub(before)).to.be.gt(0)
    })

    it('sell options within a long tick', async () => {
      // short position
      const vaultId = await testContractHelper.createAccount(other)
      const collateral = scaledBN(1000, 6)
      const shortAmount = scaledBN(1, 8)
      // deposit usdc to the vault
      await usdc.connect(other).approve(optionVault.address, collateral)
      await optionVault.connect(other).deposit(vaultId, expiryId, collateral)
      await optionVault.connect(other).write(vaultId, seriesId, shortAmount, other.address)

      // sell options
      const minFee = 0
      await optionVault.connect(other).setApprovalForAll(amm.address, true)

      const before = await usdc.balanceOf(other.address)
      await amm.connect(other).sell(seriesId, shortAmount, minFee)
      const after = await usdc.balanceOf(other.address)

      expect(await getIV(seriesId)).to.be.lt(100000000)

      expect(after.sub(before)).to.be.gt(0)
    })

    it('sell options from a short tick to a long tick', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(1000, 6)

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId, amount, maxFee)

      expect(await getIV(seriesId)).to.be.gt(100000000)

      // short position
      const vaultId = await testContractHelper.createAccount(other)
      const collateral = scaledBN(1000, 6)
      const shortAmount = scaledBN(2, 8)

      // deposit usdc to the vault
      await usdc.connect(other).approve(optionVault.address, collateral)
      await optionVault.connect(other).deposit(vaultId, expiryId, collateral)
      await optionVault.connect(other).write(vaultId, seriesId, shortAmount, other.address)

      // sell options
      const minFee = 0
      await optionVault.connect(other).setApprovalForAll(amm.address, true)

      const before = await usdc.balanceOf(other.address)
      await amm.connect(other).sell(seriesId, shortAmount, minFee)
      const after = await usdc.balanceOf(other.address)

      expect(await getIV(seriesId)).to.be.lt(100000000)

      expect(after.sub(before)).to.be.gt(0)
    })

    it('close to sell ITM option', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(1000, 6)

      // buy options
      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)

      // update price
      await testContractHelper.updateSpot(scaledBN(1100, 8))

      const minFee = 0
      const sellAmount = scaledBN(5, 7)
      await optionVault.setApprovalForAll(amm.address, true)

      // close long position
      const before = await usdc.balanceOf(wallet.address)
      await amm.sell(seriesId, sellAmount, minFee)
      const after = await usdc.balanceOf(wallet.address)

      expect(after.sub(before)).to.be.lt(premium)
    })

    it('close to sell ITM option 2', async () => {
      const amount = scaledBN(1, 7)
      const maxFee = scaledBN(1000, 6)

      await testContractHelper.updateSpot(scaledBN(1005, 8))

      // buy options
      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)

      await increaseTime(60 * 60 * 12)

      // update price
      await testContractHelper.updateSpot(scaledBN(1080, 8))

      const minFee = 0
      const sellAmount = scaledBN(1, 7)
      await optionVault.setApprovalForAll(amm.address, true)

      // close long position
      const before = await usdc.balanceOf(wallet.address)
      await amm.sell(seriesId, sellAmount, minFee)
      const after = await usdc.balanceOf(wallet.address)

      expect(after.sub(before)).to.be.gt(premium)
    })

    it('close to sell across multiple ticks(premium became cheap)', async () => {
      const amount = scaledBN(18, 8)
      const maxFee = scaledBN(3000, 6)

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId, amount, maxFee)

      const series1 = await optionVault.getOptionSeries(seriesId)
      expect(series1.iv).to.be.gt(110000000)

      await testContractHelper.updateSpot(scaledBN(950, 8))

      const amountToSell = scaledBN(18, 8)
      const minFee = 0

      await optionVault.setApprovalForAll(amm.address, true)
      await amm.sell(seriesId, amountToSell, minFee)

      const series2 = await optionVault.getOptionSeries(seriesId)
      expect(series2.iv).to.be.lt(110000000)
    })

    it('close to sell across multiple ticks(premium became expensive)', async () => {
      const amount = scaledBN(18, 8)
      const maxFee = scaledBN(3000, 6)

      await usdc.approve(amm.address, maxFee)
      await testContractHelper.buy(seriesId, amount, maxFee)

      const series1 = await optionVault.getOptionSeries(seriesId)
      expect(series1.iv).to.be.gt(110000000)

      await testContractHelper.updateSpot(scaledBN(1030, 8))

      const amountToSell = scaledBN(10, 8)
      const minFee = 0

      await optionVault.setApprovalForAll(amm.address, true)
      await amm.sell(seriesId, amountToSell, minFee)

      const series2 = await optionVault.getOptionSeries(seriesId)
      expect(series2.iv).to.be.lt(110000000)
    })

    it('reverts if amount is 0', async () => {
      const minFee = scaledBN(10, 6)
      await expect(amm.sell(seriesId, 0, minFee)).to.be.revertedWith('AMM: amount must not be 0')
    })

    it('reverts if caller does not have options', async () => {
      const amount = scaledBN(1, 8)
      const minFee = 0

      await optionVault.setApprovalForAll(amm.address, true)
      await expect(amm.sell(seriesId, amount, minFee)).to.be.revertedWith("AMM: msg.sender doesn't have enough amount")
    })

    it('reverts if premium is too small', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(1000, 6)

      // buy options
      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)

      const minFee = premium.add(scaledBN(1, 6))
      await optionVault.setApprovalForAll(amm.address, true)
      await expect(amm.sell(seriesId, amount, minFee)).to.be.revertedWith('AMM: premium is too low')
    })

    it('reverts if delta is too low', async () => {
      const amount = scaledBN(1, 8)
      const maxFee = scaledBN(1000, 6)

      // buy options
      await usdc.approve(amm.address, maxFee)
      const premium = await testContractHelper.buy(seriesId, amount, maxFee)

      // set min delta 10%
      testContractSet.amm.setConfig(AMMConfig.MIN_DELTA, scaledBN(10, 6))

      // seriesId becomes OTM(low delta)
      await testContractHelper.updateSpot(scaledBN(500, 8))

      const minFee = premium.add(scaledBN(1, 6))
      await expect(amm.sell(seriesId, amount, minFee)).to.be.revertedWith('delta is too low')
    })
  })

  describe('test of option serieses', () => {
    let expiry: number
    let expiry2: number
    let boards: {
      expiryId: any
      calls: BigNumber[]
      puts: BigNumber[]
    }[] = []
    const depositAmount = scaledBN(6000, 6)
    const lower = 8
    const upper = 12
    const rangeId = genRangeId(lower, upper)
    const strike1 = scaledBN(1000, 8)
    const strike2 = scaledBN(1100, 8)

    beforeEach(async () => {
      expiry = await getExpiry(28)
      expiry2 = await getExpiry(35)
      const iv1 = scaledBN(100, 6)
      const iv2 = scaledBN(80, 6)

      boards.push(await testContractHelper.createExpiry(expiry, [strike1, strike2], [iv1, iv2]))

      boards.push(await testContractHelper.createExpiry(expiry2, [strike1, strike2], [iv1, iv2]))

      // deposit usdc to AMM
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, lower, upper)
    })

    describe('settle', () => {
      it('settle short positions', async () => {
        const seriesId = boards[0].calls[0]
        const expiryId = boards[0].expiryId

        const price = scaledBN(1020, 8)
        // 0.8 ETH
        const amount = scaledBN(8, 7)
        const maxFee = scaledBN(1000, 6)

        // buy options
        await usdc.approve(amm.address, maxFee)
        const premium = await testContractHelper.buy(seriesId, amount, maxFee)

        // expiration passed
        await setTime(expiry + 60)
        await testContractHelper.updateExpiryPrice(expiry, price)
        await increaseTime(60 * 60 * 2)

        // settlement
        await amm.settle(expiryId)

        const balance = await amm.balanceOf(wallet.address, rangeId)
        const withdrawAmount = await amm.getWithdrawableAmount(balance, lower, upper)
        const payout = amount.mul(price.sub(strike1)).div(scaledBN(1, 10))

        const protocolFee = await getProtocolFee()

        expect(withdrawAmount).to.be.eq(depositAmount.add(premium).sub(payout).sub(protocolFee))

        await expect(amm.settle(expiryId)).to.be.revertedWith('AMMLib: ticks are already settled')
      })

      it('settle without short positions', async () => {
        const seriesId = boards[1].calls[0]

        const price = scaledBN(1020, 8)

        // 0.8 ETH
        const amount = scaledBN(8, 7)
        const maxFee = scaledBN(1000, 6)

        // buy options
        await usdc.approve(amm.address, maxFee)
        await testContractHelper.buy(seriesId, amount, maxFee)

        // expiration passed
        await setTime(expiry + 60)
        await testContractHelper.updateExpiryPrice(expiry, price)
        await increaseTime(60 * 60 * 2)

        // settlement
        await expect(amm.settle(boards[0].expiryId)).to.be.revertedWith('AMMLib: ticks are already settled')

        // expiration passed
        await setTime(expiry2 + 60)
        await testContractHelper.updateExpiryPrice(expiry2, price)
        await increaseTime(60 * 60 * 2)

        await amm.settle(boards[1].expiryId)
      })

      it('settle without short positions but with cumulative fee', async () => {
        const seriesId = boards[0].calls[0]

        const price = scaledBN(1020, 8)
        // 0.8 ETH
        const amount = scaledBN(8, 7)
        const maxFee = scaledBN(1000, 6)

        // buy options
        await usdc.approve(amm.address, maxFee)
        const premium = await testContractHelper.buy(seriesId, amount, maxFee)
        const premiumToSell = await testContractHelper.sell(seriesId, amount, 0, wallet)

        // expiration passed
        await setTime(expiry + 60)
        await testContractHelper.updateExpiryPrice(expiry, price)
        await increaseTime(60 * 60 * 2)

        // settlement
        await amm.settle(boards[0].expiryId)

        const balance = await amm.balanceOf(wallet.address, rangeId)
        const withdrawAmount = await amm.getWithdrawableAmount(balance, lower, upper)

        const protocolFee = await getProtocolFee()

        expect(withdrawAmount).to.be.eq(depositAmount.add(premium).sub(premiumToSell).sub(protocolFee))

        await expect(amm.settle(boards[0].expiryId)).to.be.revertedWith('AMMLib: ticks are already settled')
      })

      it('settle long positions', async () => {
        const seriesId = boards[0].calls[0]

        // make short position
        const vaultId = await testContractHelper.createAccount(other)
        const collateral = scaledBN(1000, 6)
        const shortAmount = scaledBN(2, 7)

        // sell options
        const premium = await makeShortPosition(vaultId, boards[0].expiryId, seriesId, shortAmount, collateral, other)

        const price = scaledBN(1050, 8)

        // expiration passed
        await setTime(expiry + 60)
        await testContractHelper.updateExpiryPrice(expiry, price)
        await increaseTime(60 * 60 * 2)

        // settlement
        await amm.settle(boards[0].expiryId)

        const balance = await amm.balanceOf(wallet.address, rangeId)
        const withdrawAmount = await amm.getWithdrawableAmount(balance, lower, upper)

        const payout = shortAmount.mul(price.sub(strike1)).div(scaledBN(1, 10))

        expect(withdrawAmount).to.be.eq(depositAmount.add(payout).sub(premium))

        await expect(amm.settle(boards[0].expiryId)).to.be.revertedWith('AMMLib: ticks are already settled')
      })

      it('settle multiple positions', async () => {
        const seriesId1 = boards[0].calls[0]
        const seriesId2 = boards[0].calls[1]
        const expiryId = boards[0].expiryId

        // 0.5 ETH
        const amount1 = scaledBN(5, 7)
        // 1.5 ETH
        const amount2 = scaledBN(15, 7)
        const maxFee = scaledBN(1000, 6)

        // testContractHelper.buy options
        await usdc.approve(amm.address, maxFee)
        const premium1 = await testContractHelper.buy(seriesId1, amount1, maxFee)
        const premium2 = await testContractHelper.buy(seriesId2, amount2, maxFee)

        await increaseTime(60 * 60 * 24)
        // $1030
        await testContractHelper.updateSpot(scaledBN(1020, 8))

        // make short position
        const vaultId = await testContractHelper.createAccount(other)
        const collateral = scaledBN(1000, 6)
        const shortAmount1 = scaledBN(6, 7)
        const shortAmount2 = scaledBN(10, 7)

        // sell options
        const receivedPremium1 = await makeShortPosition(vaultId, expiryId, seriesId1, shortAmount1, collateral, other)
        const receivedPremium2 = await makeShortPosition(vaultId, expiryId, seriesId2, shortAmount2, collateral, other)

        // $1020
        const price = scaledBN(1050, 8)

        // expiration passed
        await setTime(expiry + 60)
        await testContractHelper.updateExpiryPrice(expiry, price)
        await increaseTime(60 * 60 * 2)

        // settlement
        await amm.settle(expiryId)

        const balance = await amm.balanceOf(wallet.address, rangeId)
        const withdrawAmount = await amm.getWithdrawableAmount(balance, lower, upper)

        const payout1 = shortAmount1.sub(amount1).mul(price.sub(strike1)).div(scaledBN(1, 10))
        // const payout2 = (amount2.sub(shortAmount2)).mul(price.sub(strike2)).div(scaledBN(1, 10))

        const premium = premium1.add(premium2)
        const receivedPremium = receivedPremium1.add(receivedPremium2)

        const protocolFee = await getProtocolFee()

        expect(withdrawAmount).to.be.eq(depositAmount.add(payout1).add(premium).sub(receivedPremium).sub(protocolFee))

        await expect(amm.settle(expiryId)).to.be.revertedWith('AMMLib: ticks are already settled')
      })

      it('reverts if option series has not been expired', async () => {
        const seriesId = boards[0].calls[0]
        const expiryId = boards[0].expiryId

        // 0.8 ETH
        const amount = scaledBN(8, 7)
        const maxFee = scaledBN(1000, 6)

        // testContractHelper.buy options
        await usdc.approve(amm.address, maxFee)
        await testContractHelper.buy(seriesId, amount, maxFee)

        // settlement
        await expect(amm.settle(expiryId)).to.be.revertedWith(VaultErrors.PRICE_MUST_BE_FINALIZED)
      })

      it('reverts if hedge position is not neutral', async () => {
        const seriesId = boards[0].calls[0]
        const expiryId = boards[0].expiryId

        const tickId = 10
        const price = scaledBN(1020, 8)
        const amount = scaledBN(8, 7)
        const maxFee = scaledBN(1000, 6)

        // buy options
        await usdc.approve(amm.address, maxFee)
        await testContractHelper.buy(seriesId, amount, maxFee)

        await testContractHelper.updateSpot(price)

        // delta hedging
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId)

        const longSize = tickDelta.abs()

        await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))
        await optionVault.addUnderlyingLong(tickId, expiryId, longSize, longSize.mul(price).div(scaledBN(1, 10)))
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId)
        expect(hedgePosition).to.be.gt(0)

        // expiration passed
        await setTime(expiry + 60)
        await testContractHelper.updateExpiryPrice(expiry, price)
        await increaseTime(60 * 60 * 2)

        // settlement
        await expect(amm.settle(expiryId)).to.be.revertedWith('OptionLib: hedge position must be neutral')
      })
    })

    describe('rebalanceCollateral', () => {
      const price = scaledBN(1050, 8)

      it('rebalance collateral in the vault', async () => {
        const tickId = 10
        const expiryId = boards[0].expiryId

        // 0.8 ETH
        const amount = scaledBN(8, 7)
        const maxFee = scaledBN(1000, 6)

        await testContractHelper.updateSpot(price)

        // buy options
        await usdc.approve(amm.address, maxFee)
        await testContractHelper.buy(boards[0].calls[0], amount, maxFee)

        const beforeBalance1 = await usdc.balanceOf(amm.address)
        await amm.rebalanceCollateral(tickId, expiryId)
        const afterBalance1 = await usdc.balanceOf(amm.address)

        // vault swaps USDC for WETH
        const longSize = amount.div(3)
        const usdcAmount = longSize.mul(price).div(scaledBN(1, 10))
        await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))
        await optionVault.addUnderlyingLong(tickId, expiryId, longSize, usdcAmount)

        // can not withdraw a part of unrequired collaterals
        await testContractHelper.sell(boards[0].calls[0], amount, 0, wallet)

        // vault swaps WETH for USDC
        await usdc.approve(optionVault.address, usdcAmount)
        await optionVault.addUnderlyingShort(tickId, expiryId, longSize, usdcAmount)

        // rebalance
        const beforeBalance2 = await usdc.balanceOf(amm.address)
        await amm.rebalanceCollateral(tickId, expiryId)
        const afterBalance2 = await usdc.balanceOf(amm.address)

        expect(afterBalance1).to.be.eq(beforeBalance1)
        expect(afterBalance2).to.be.gt(beforeBalance2)
      })
    })
  })

  describe('operator functions', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    let expiry: number
    const depositAmount = scaledBN(6000, 6)
    const lower = 8
    const upper = 12
    const strike = scaledBN(1000, 8)

    beforeEach(async () => {
      expiry = await getExpiry(28)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]

      // deposit usdc to AMM
      await usdc.approve(amm.address, depositAmount)
      await amm.deposit(depositAmount, depositAmount, lower, upper)
    })

    it('change state', async () => {
      const amount = scaledBN(8, 7)
      const maxFee = scaledBN(1000, 6)

      await amm.changeState(true)

      await expect(testContractHelper.buy(seriesId, amount, maxFee)).to.be.revertedWith('AMM: emergency mode')
    })

    it('reverts if caller is not operator', async () => {
      await expect(amm.connect(other).changeState(true)).to.be.revertedWith('AMM: caller must be operator')
    })

    it('set protocol fee ratio', async () => {
      const value = 10

      await amm.setConfig(AMMConfig.PROTOCOL_FEE_RATIO, value)

      const result = await amm.getConfig(AMMConfig.PROTOCOL_FEE_RATIO)
      expect(result).to.be.eq(value)
    })

    it('setting protocol ratio reverts if caller is not operator', async () => {
      await expect(amm.connect(other).setConfig(AMMConfig.PROTOCOL_FEE_RATIO, 1)).to.be.revertedWith(
        'AMM: caller must be operator',
      )
    })

    it('set iv move decrease ratio', async () => {
      const value = 1

      await amm.setConfig(AMMConfig.IVMOVE_DECREASE_RATIO, value)

      const result = await amm.getConfig(AMMConfig.IVMOVE_DECREASE_RATIO)
      expect(result).to.be.eq(value)
    })

    it('setting iv move decrease ratio reverts if caller is not operator', async () => {
      await expect(amm.connect(other).setConfig(AMMConfig.IVMOVE_DECREASE_RATIO, 1)).to.be.revertedWith(
        'AMM: caller must be operator',
      )
    })

    it('set bot address', async () => {
      await amm.setBot(other.address)

      await expect(amm.settle(expiryId)).to.be.revertedWith('AMM: caller must be bot')
    })

    it('setting bot address reverts if caller is not operator', async () => {
      await expect(amm.connect(other).setBot(other.address)).to.be.revertedWith('AMM: caller must be operator')
    })

    it('set new operator', async () => {
      // can not update operator except operator
      await expect(amm.connect(other).setNewOperator(other.address)).to.be.revertedWith('AMM: caller must be operator')

      await amm.setNewOperator(other.address)

      // new operator can call setBot
      await amm.connect(other).setBot(other.address)

      // previous operator can't call setBot
      await expect(amm.setBot(other.address)).to.be.revertedWith('AMM: caller must be operator')
    })
  })
})
