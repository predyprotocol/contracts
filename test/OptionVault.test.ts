import { ethers } from 'hardhat'
import { expect } from 'chai'
import { MockERC20, OptionVault } from '../typechain'
import { BigNumber, Wallet } from 'ethers'
import { getExpiry, increaseTime, scaledBN, setTime } from './utils/helpers'
import { DISPUTE_PERIOD, EXTENSION_PERIOD, MarginLevel, OptionVaultConfig } from './constants'
import {
  deployTestContractSet,
  restoreSnapshot,
  takeSnapshot,
  TestContractHelper,
  TestContractSet,
} from './utils/deploy'
import { VaultErrors } from './utils/errors'

describe('OptionVault', function () {
  let wallet: Wallet, other: Wallet, liquidator: Wallet
  let weth: MockERC20
  let usdc: MockERC20
  let optionVault: OptionVault
  let testContractSet: TestContractSet
  let testContractHelper: TestContractHelper
  let snapshotId: number
  const initialSpot = scaledBN(1000, 8)

  before(async () => {
    ;[wallet, other, liquidator] = await (ethers as any).getSigners()

    testContractSet = await deployTestContractSet(wallet)
    testContractHelper = new TestContractHelper(testContractSet)

    weth = testContractSet.weth
    usdc = testContractSet.usdc
    optionVault = testContractSet.optionVault

    // mint 100 ETH
    const testAmount = scaledBN(100, 18)
    await weth.mint(wallet.address, testAmount)

    // mint 100 USDC
    const testUsdcAmount = scaledBN(100000, 6)
    await usdc.mint(wallet.address, testUsdcAmount)
    await usdc.mint(other.address, testUsdcAmount)
  })

  beforeEach(async () => {
    snapshotId = await takeSnapshot()

    await testContractHelper.updateSpot(initialSpot)
  })

  afterEach(async () => {
    await restoreSnapshot(snapshotId)
  })

  describe('createExpiry', () => {
    it('reverts if caller is not operator', async () => {
      const expiry = await getExpiry(1)

      await expect(optionVault.connect(other).createExpiry(expiry, [], [], [])).to.be.revertedWith(
        VaultErrors.CALLER_MST_BE_OPERATOR,
      )
    })

    it('reverts if expiry is earlier than now', async () => {
      const expiry = await getExpiry(1)

      await expect(optionVault.createExpiry(expiry - 60 * 60 * 24 * 2, [], [], [])).to.be.revertedWith(
        'OptionLib: expiry must be greater than now',
      )
    })

    it('reverts if expiry is earlier than last created', async () => {
      const expiry1 = await getExpiry(1)
      const expiry2 = await getExpiry(2)

      await optionVault.createExpiry(expiry2, [], [], [])

      await expect(optionVault.createExpiry(expiry1, [], [], [])).to.be.revertedWith(
        'OptionLib: expiry must be greater than or equal to last created',
      )
    })

    it('reverts if iv is 0', async () => {
      const expiry1 = await getExpiry(1)
      const strike = scaledBN(1000, 8)
      const iv = 0

      await expect(optionVault.createExpiry(expiry1, [strike], [iv], [iv])).to.be.revertedWith(
        'OptionLib: iv must be greater than 0 and less than 1000%',
      )
    })

    it('create an expiration', async () => {
      const expiry1 = await getExpiry(1)
      const strike1 = scaledBN(1000, 8)
      const strike2 = scaledBN(1200, 8)
      const calliv = scaledBN(100, 6)
      const putiv = scaledBN(110, 6)

      await optionVault.createExpiry(expiry1, [strike1, strike2], [calliv, calliv], [putiv, putiv])

      const call = await optionVault.getOptionSeries(1)
      const put = await optionVault.getOptionSeries(2)

      expect(call.iv).itself.be.eq(calliv)
      expect(put.iv).itself.be.eq(putiv)
    })

    it('create expirations', async () => {
      const expiry1 = await getExpiry(1)
      const expiry2 = await getExpiry(2)
      const strike1 = scaledBN(1000, 8)
      const strike2 = scaledBN(1200, 8)
      const iv = scaledBN(100, 6)

      await optionVault.createExpiry(expiry1, [strike1, strike2], [iv, iv], [iv, iv])

      const result = await testContractHelper.createExpiry(expiry2, [strike1, strike2], [iv, iv])

      const expiration = await optionVault.getExpiration(result.expiryId)

      expect(expiration.expiry).to.be.eq(expiry2)

      const series = await optionVault.getOptionSeries(result.calls[0])

      expect(series.expiry).to.be.eq(expiry2)
    })
  })

  describe('createAccount', () => {
    let expiryId: BigNumber
    let expiry: number

    beforeEach(async () => {
      expiry = await getExpiry(1)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
    })

    it('create a vault', async () => {
      const vaultId = await testContractHelper.createAccount(wallet)

      const optionInfo = await testContractSet.optionVault.optionInfo()

      expect(vaultId).to.be.eq(optionInfo.vaultCount.sub(1))

      const account = await testContractSet.optionVault.getAccount(vaultId)

      expect(account.owner).to.be.eq(wallet.address)
      expect(account.settledCount).to.be.eq(0)
    })
  })

  describe('deposit', () => {
    let expiryId: BigNumber
    let vaultId: BigNumber
    let expiry: number

    beforeEach(async () => {
      expiry = await getExpiry(1)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId

      vaultId = await testContractHelper.createAccount(wallet)
    })

    it('reverts if amount is 0', async () => {
      await expect(optionVault.deposit(vaultId, expiryId, 0)).to.be.revertedWith(VaultErrors.AMOUNT_GT_0)
    })

    it('reverts if not approved', async () => {
      const depositAmount = scaledBN(2000, 6)

      await expect(optionVault.deposit(vaultId, expiryId, depositAmount)).to.be.revertedWith(
        'ERC20: transfer amount exceeds allowance',
      )
    })

    it('deposit collateral', async () => {
      const depositAmount = scaledBN(2000, 6)
      await usdc.approve(optionVault.address, depositAmount)

      // deposit
      const before = await usdc.balanceOf(wallet.address)
      await expect(optionVault.deposit(vaultId, expiryId, depositAmount))
        .to.emit(optionVault, 'VaultDeposited')
        .withArgs(vaultId, expiryId, depositAmount)
      const after = await usdc.balanceOf(wallet.address)

      expect(before.sub(after)).to.be.eq(depositAmount)
    })
  })

  describe('withdraw', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    let vaultId: BigNumber
    let expiry: number
    const strike = scaledBN(1000, 8)

    beforeEach(async () => {
      expiry = await getExpiry(1)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]

      vaultId = await testContractHelper.createAccount(wallet)
    })

    it('reverts if amount is 0', async () => {
      await expect(optionVault.withdraw(vaultId, expiryId, 0)).to.be.revertedWith(VaultErrors.AMOUNT_GT_0)
    })

    it('reverts if collateral is not enough', async () => {
      const depositAmount = scaledBN(2000, 6)

      // deposit usdc
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)

      await optionVault.write(vaultId, seriesId, scaledBN(2, 7), wallet.address)

      await expect(optionVault.withdraw(vaultId, expiryId, depositAmount)).to.be.revertedWith(
        'OptionLib: collateral is not enough',
      )
    })

    it('withdraw after option has been expired', async () => {
      const depositAmount = scaledBN(500, 6)

      // deposit usdc
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)

      const amount = scaledBN(5, 7)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      const price = scaledBN(1010, 8)

      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(60 * 60 * 2)

      const payout = price.sub(strike).mul(amount).div(scaledBN(1, 10))

      await expect(optionVault.withdraw(vaultId, expiryId, payout)).to.be.revertedWith(
        'OptionLib: option series has been expired',
      )
    })

    it('withdraw collateral', async () => {
      const depositAmount = scaledBN(2000, 6)

      // deposit usdc to the vault
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)

      // withdraw usdc from the vault
      const before = await usdc.balanceOf(wallet.address)
      await expect(optionVault.withdraw(vaultId, expiryId, depositAmount))
        .to.emit(optionVault, 'VaultWithdrawn')
        .withArgs(vaultId, expiryId, depositAmount)
      const after = await usdc.balanceOf(wallet.address)

      expect(after.sub(before)).to.be.eq(depositAmount)
    })
  })

  describe('write', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    let vaultId: BigNumber
    let expiry: number

    beforeEach(async () => {
      expiry = await getExpiry(28)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]

      vaultId = await testContractHelper.createAccount(wallet)
    })

    it('reverts if amount is 0', async () => {
      await expect(optionVault.write(vaultId, seriesId, 0, wallet.address)).to.be.revertedWith(VaultErrors.AMOUNT_GT_0)
    })

    it('write options', async () => {
      const depositAmount = scaledBN(2000, 6)
      const amount = scaledBN(1, 8)

      // deposit usdc to the  cault
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)

      // write options
      const before = await optionVault.balanceOf(wallet.address, seriesId)
      await expect(optionVault.write(vaultId, seriesId, amount, wallet.address))
        .to.emit(optionVault, 'Written')
        .withArgs(vaultId, seriesId, amount, wallet.address)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
    })

    it('reverts if collateral is not enough', async () => {
      const depositAmount = scaledBN(2000, 6)
      const amount = scaledBN(10, 8)

      // deposit usdc to the vault
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)

      // write options
      await expect(optionVault.write(vaultId, seriesId, amount, wallet.address)).to.be.revertedWith(
        'OptionLib: collateral is not enough',
      )
    })

    it('reverts if there is no collateral', async () => {
      const amount = scaledBN(1, 8)

      // write options
      await expect(optionVault.write(vaultId, seriesId, amount, wallet.address)).to.be.revertedWith(
        'OptionLib: collateral is not enough',
      )
    })

    it('reverts if the series has been expired', async () => {
      const depositAmount = scaledBN(2000, 6)
      const amount = scaledBN(1, 8)

      // deposit usdc to the vault
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)

      await setTime(expiry + 60)

      // write options
      await expect(optionVault.write(vaultId, seriesId, amount, wallet.address)).to.be.revertedWith(
        'OptionLib: option series has been expired',
      )
    })

    it('write options after unlock', async () => {
      const depositAmount = scaledBN(2000, 6)
      const amount = scaledBN(1, 8)

      // deposit usdc to the  cault
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)

      // write and unlock
      await optionVault.write(vaultId, seriesId, amount, wallet.address)
      await optionVault.closeShortPosition(vaultId, seriesId, amount.div(2), scaledBN(5, 5))

      // write options
      const before = await optionVault.balanceOf(wallet.address, seriesId)
      await optionVault.write(vaultId, seriesId, amount.div(2), wallet.address)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount.div(2))
    })
  })

  describe('closeShortPosition', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    let accountId: BigNumber
    let expiry: number
    const cRatio = scaledBN(1, 6)
    const depositAmount = scaledBN(2000, 6)

    beforeEach(async () => {
      expiry = await getExpiry(1)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]

      accountId = await testContractHelper.createAccount(wallet)

      // deposit usdc
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(accountId, expiryId, depositAmount)
    })

    it('reverts if caller does not have options', async () => {
      const amount = scaledBN(1, 8)

      await expect(optionVault.closeShortPosition(accountId, seriesId, amount, cRatio)).to.be.revertedWith(
        VaultErrors.AMOUNT_EXCEED_BALANCE,
      )
    })

    it('reverts if series id is invalid', async () => {
      const amount = scaledBN(1, 8)

      // write options
      await optionVault.write(accountId, seriesId, amount, wallet.address)

      const invalidSeriesId = 100

      await expect(optionVault.closeShortPosition(accountId, invalidSeriesId, 0, cRatio)).to.be.revertedWith(
        'OptionLib: expiry not found',
      )
    })

    it('reverts if option series has been expired', async () => {
      const amount = scaledBN(1, 8)

      // write options
      await optionVault.write(accountId, seriesId, amount, wallet.address)

      await setTime(expiry + 60)

      await expect(optionVault.closeShortPosition(accountId, seriesId, 0, cRatio)).to.be.revertedWith(
        'OptionLib: option series has been expired',
      )
    })

    it('unlock all options and withdraw all', async () => {
      const amount = scaledBN(1, 8)

      // write options
      await optionVault.write(accountId, seriesId, amount, wallet.address)

      // unlock options
      const before = await optionVault.balanceOf(wallet.address, seriesId)
      await expect(optionVault.closeShortPosition(accountId, seriesId, amount, cRatio))
        .to.emit(optionVault, 'Unlocked')
        .withArgs(accountId, seriesId, amount, wallet.address)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(before.sub(after)).to.be.eq(amount)
    })

    it('unlock some options and withdraw', async () => {
      const amount = scaledBN(1, 8)

      // write options
      await optionVault.write(accountId, seriesId, amount, wallet.address)

      const amountToClose = scaledBN(5, 7)

      // unlock options
      const before = await optionVault.balanceOf(wallet.address, seriesId)
      await expect(optionVault.closeShortPosition(accountId, seriesId, amountToClose, cRatio))
        .to.emit(optionVault, 'Unlocked')
        .withArgs(accountId, seriesId, amountToClose, wallet.address)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(before.sub(after)).to.be.eq(amountToClose)
    })

    it('unlock nothing and withdraw', async () => {
      const amount = scaledBN(1, 8)

      // write options
      await optionVault.write(accountId, seriesId, amount, wallet.address)

      // unlock options
      const before = await usdc.balanceOf(wallet.address)
      await optionVault.closeShortPosition(accountId, seriesId, 0, cRatio)
      const after = await usdc.balanceOf(wallet.address)

      const balanceOfVault = await usdc.balanceOf(optionVault.address)

      // assertions
      expect(after.sub(before)).to.be.eq(depositAmount.sub(balanceOfVault))
    })

    it('unlock and withdraw nothing', async () => {
      const amount = scaledBN(1, 8)

      // write options
      await optionVault.write(accountId, seriesId, amount, wallet.address)

      const amountToClose = scaledBN(5, 7)

      // unlock options
      const before = await usdc.balanceOf(wallet.address)
      await optionVault.closeShortPosition(accountId, seriesId, amountToClose, 1)
      const after = await usdc.balanceOf(wallet.address)

      // assertions
      expect(before.sub(after)).to.be.eq(0)
    })
  })

  describe('depositAndWrite', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    let vaultId: BigNumber

    beforeEach(async () => {
      const expiry = await getExpiry(28)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]

      vaultId = await testContractHelper.createAccount(wallet)
    })

    it('reverts if collateral is 0', async () => {
      const amount = scaledBN(1, 8)

      await expect(optionVault.depositAndWrite(vaultId, seriesId, 0, amount, wallet.address)).to.be.revertedWith(
        VaultErrors.CRATIO_IS_BETWEEN_0_AND_1E6,
      )
    })

    it('reverts if amount is 0', async () => {
      const depositAmount = scaledBN(2000, 6)

      await expect(optionVault.depositAndWrite(vaultId, seriesId, depositAmount, 0, wallet.address)).to.be.revertedWith(
        VaultErrors.AMOUNT_GT_0,
      )
    })

    it('deposit collateral and write options', async () => {
      const amount = scaledBN(1, 8)
      const minColat = await optionVault.calRequiredMarginForASeries(seriesId, amount, MarginLevel.Initial)
      const cRatio = scaledBN(1, 6)

      // write options
      const before = await optionVault.balanceOf(wallet.address, seriesId)
      await usdc.approve(optionVault.address, minColat)
      await expect(optionVault.depositAndWrite(vaultId, seriesId, cRatio, amount, wallet.address))
        .to.emit(optionVault, 'Written')
        .withArgs(vaultId, seriesId, amount, wallet.address)
      const after = await optionVault.balanceOf(wallet.address, seriesId)

      // assertions
      expect(after.sub(before)).to.be.eq(amount)
    })
  })

  describe('settleVault', () => {
    let expiryId: BigNumber
    let expiryId30: BigNumber
    let seriesId: BigNumber
    let seriesId2: BigNumber
    let seriesId3: BigNumber
    let vaultId: BigNumber
    let expiry: number
    let expiry30: number

    const depositAmount = scaledBN(2000, 6)
    const strike = scaledBN(1000, 8)
    const strike2 = scaledBN(1100, 8)

    beforeEach(async () => {
      expiry = await getExpiry(28)
      expiry30 = await getExpiry(30)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike, strike2], [iv, iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]
      seriesId2 = result.calls[1]

      const result30 = await testContractHelper.createExpiry(expiry30, [strike], [iv])
      expiryId30 = result30.expiryId
      seriesId3 = result30.calls[0]

      vaultId = await testContractHelper.createAccount(wallet)

      // deposit usdc
      await usdc.approve(optionVault.address, depositAmount.mul(2))
      await optionVault.deposit(vaultId, expiryId, depositAmount)
      await optionVault.deposit(vaultId, expiryId30, depositAmount)
    })

    it('settle vault', async () => {
      const price = scaledBN(1100, 8)
      const amount = scaledBN(1, 8)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(60 * 60 * 2)

      const before = await usdc.balanceOf(wallet.address)
      await optionVault.settleVault(vaultId, expiryId)
      const after = await usdc.balanceOf(wallet.address)

      const payout = amount.mul(price.sub(initialSpot)).div(scaledBN(1, 10))
      expect(after.sub(before)).to.be.eq(depositAmount.sub(payout))

      await expect(optionVault.settleVault(vaultId, expiryId)).to.be.revertedWith('OptionLib: vault already settled')

      const account = await testContractSet.optionVault.getAccount(vaultId)

      expect(account.settledCount).to.be.eq(expiryId)
    })

    it('settle vault that created after settlement', async () => {
      const price = scaledBN(1100, 8)
      const amount = scaledBN(1, 8)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      // update expiry price
      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(DISPUTE_PERIOD)

      await optionVault.settleVault(vaultId, expiryId)

      // create account after settlement
      const vaultId2 = await testContractHelper.createAccount(wallet)

      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId2, expiryId30, depositAmount)

      await optionVault.write(vaultId2, seriesId3, amount, wallet.address)

      // update expiry price
      await setTime(expiry30 + 60)
      await testContractHelper.updateExpiryPrice(expiry30, price)
      await increaseTime(DISPUTE_PERIOD)

      const before = await usdc.balanceOf(wallet.address)
      await optionVault.settleVault(vaultId2, expiryId30)
      const after = await usdc.balanceOf(wallet.address)

      const payout = amount.mul(price.sub(initialSpot)).div(scaledBN(1, 10))
      expect(after.sub(before)).to.be.eq(depositAmount.sub(payout))

      const account = await testContractSet.optionVault.getAccount(vaultId2)

      expect(account.settledCount).to.be.eq(expiryId30)
    })

    it('reverts if option series has not been expired', async () => {
      const amount = scaledBN(5, 8)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      await expect(optionVault.settleVault(vaultId, expiryId)).to.be.revertedWith(VaultErrors.PRICE_MUST_BE_FINALIZED)
    })

    it('reverts if vault is insolvency', async () => {
      const price = scaledBN(1500, 8)
      const amount = scaledBN(5, 8)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(60 * 60 * 2)

      const before = await usdc.balanceOf(wallet.address)
      await optionVault.settleVault(vaultId, expiryId)
      const after = await usdc.balanceOf(wallet.address)

      expect(after.sub(before)).to.be.eq(0)
    })

    it('settle an insolvency vault', async () => {
      const price = scaledBN(3000, 8)
      const amount = scaledBN(2, 8)

      // insolvency mode
      await optionVault.write(vaultId, seriesId, amount, wallet.address)
      await testContractHelper.updateSpot(price)

      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(60 * 60 * 2)

      const before = await usdc.balanceOf(wallet.address)
      await optionVault.settleVault(vaultId, expiryId)
      const after = await usdc.balanceOf(wallet.address)

      expect(after.sub(before)).to.be.eq(0)
    })

    it('reverts if skip non-empty option series', async () => {
      const price = scaledBN(1005, 8)
      const amount = scaledBN(5, 7)

      await optionVault.write(vaultId, seriesId3, amount, wallet.address)

      await setTime(expiry30 + 60)
      await testContractHelper.updateExpiryPrice(expiry30, price)
      await increaseTime(60 * 60 * 2)

      // settle expiryId30 skipping seriesId
      await expect(optionVault.settleVault(vaultId, expiryId30)).to.be.revertedWith('OptionLib: can not skip expiry')
    })
  })

  describe('claim', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    let vaultId: BigNumber
    let expiry: number
    const depositAmount = scaledBN(2000, 6)

    beforeEach(async () => {
      expiry = await getExpiry(28)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]

      vaultId = await testContractHelper.createAccount(wallet)

      // deposit usdc to the vault
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)
    })

    it('claim profit for 1.2 ETH options', async () => {
      const price = scaledBN(1100, 8)
      // 1.2 ether
      const amount = scaledBN(12, 7)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(60 * 60 * 2)

      // claim profit
      const before = await usdc.balanceOf(wallet.address)
      await optionVault.claim(seriesId, amount)
      const after = await usdc.balanceOf(wallet.address)

      const payout = amount.mul(price.sub(initialSpot)).div(scaledBN(1, 10))
      expect(after.sub(before)).to.be.eq(payout)
    })

    it('reverts if caller does not have options', async () => {
      const price = scaledBN(1100, 8)
      const amount = scaledBN(1, 8)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(60 * 60 * 2)

      await expect(optionVault.connect(other).claim(seriesId, amount)).to.be.revertedWith(
        VaultErrors.AMOUNT_EXCEED_BALANCE,
      )
    })

    it('reverts if option holder claims before expiry price is finalized', async () => {
      const amount = scaledBN(1, 8)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      await expect(optionVault.claim(seriesId, amount)).to.be.revertedWith(VaultErrors.PRICE_MUST_BE_FINALIZED)
    })
  })

  describe('liquidate', () => {
    let expiryId: BigNumber
    let callId: BigNumber
    let callId2: BigNumber
    let putId: BigNumber
    let vaultId: BigNumber
    let expiry: number
    const depositAmount = scaledBN(1000, 6)
    const BASE_LIQ_REWARD = scaledBN(100, 6)

    beforeEach(async () => {
      expiry = await getExpiry(7)
      const strike1 = scaledBN(1000, 8)
      const strike2 = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike1, strike2], [iv, iv])
      expiryId = result.expiryId
      callId = result.calls[0]
      callId2 = result.calls[1]
      putId = result.puts[0]

      vaultId = await testContractHelper.createAccount(wallet)

      // deposit usdc to the vault
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)
    })

    describe('call', async () => {
      it('reverts if amount is larger than burnable', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, callId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, callId, amount, '0x')

        const spot = scaledBN(1390, 8)
        await testContractHelper.updateSpot(spot)

        // check vault's collateral is less than maintenance margin
        const maintenanceMargin = await optionVault.getRequiredMargin(vaultId, expiryId, MarginLevel.Maintenance)
        expect(maintenanceMargin).to.be.gt(depositAmount)

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, callId)

        // liquidate
        await expect(optionVault.connect(liquidator).liquidate(vaultId, callId, liqAmount.add(1))).to.be.revertedWith(
          'OptionLib: amount exceeds liquidatable limit',
        )
      })

      it('liquidate a vault', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, callId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, callId, amount, '0x')

        const spot = scaledBN(1390, 8)
        await testContractHelper.updateSpot(spot)

        // check vault's collateral is less than maintenance margin
        const maintenanceMargin = await optionVault.getRequiredMargin(vaultId, expiryId, MarginLevel.Maintenance)
        expect(maintenanceMargin).to.be.gt(depositAmount)

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, callId)

        const MIN_SIZE = scaledBN(1, 6)
        expect(liqAmount).to.be.lt(amount)
        expect(liqAmount).to.be.gt(MIN_SIZE)

        // liquidate
        const before = await usdc.balanceOf(liquidator.address)
        await optionVault.connect(liquidator).liquidate(vaultId, callId, liqAmount)
        const after = await usdc.balanceOf(liquidator.address)

        const afterLiqAmount = await optionVault.getLiquidatableAmount(vaultId, callId)
        expect(afterLiqAmount).to.be.eq(0)

        // total amount of collateral is not changed
        const vault = await optionVault.getVault(vaultId, expiryId)
        expect(after.sub(before).add(vault.collateral)).to.be.eq(depositAmount)

        expect(after.sub(before)).to.be.gt(
          BASE_LIQ_REWARD.add(spot.sub(initialSpot).mul(liqAmount).div(scaledBN(1, 10))),
        )
      })

      it('liquidate a vault writing 2 calls', async () => {
        const amount = scaledBN(1, 8)

        await optionVault.write(vaultId, callId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, callId, amount, '0x')

        await optionVault.write(vaultId, callId2, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, callId2, amount, '0x')

        const spot = scaledBN(1370, 8)
        await testContractHelper.updateSpot(spot)

        // check vault's collateral is less than maintenance margin
        const maintenanceMargin = await optionVault.getRequiredMargin(vaultId, expiryId, MarginLevel.Maintenance)
        expect(maintenanceMargin).to.be.gt(depositAmount)

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, callId)

        const MIN_SIZE = scaledBN(1, 6)
        expect(liqAmount).to.be.lt(amount)
        expect(liqAmount).to.be.gt(MIN_SIZE)

        // liquidate
        await optionVault.connect(liquidator).liquidate(vaultId, callId, liqAmount)

        const afterLiqAmount1 = await optionVault.getLiquidatableAmount(vaultId, callId)
        expect(afterLiqAmount1).to.be.eq(0)

        const afterLiqAmount2 = await optionVault.getLiquidatableAmount(vaultId, callId2)
        expect(afterLiqAmount2).to.be.eq(0)
      })

      it('liquidate all collateral of a vault', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, callId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, callId, amount, '0x')

        const spot = scaledBN(1800, 8)
        await testContractHelper.updateSpot(spot)

        // check vault's collateral is less than maintenance margin
        const maintenanceMargin = await optionVault.getRequiredMargin(vaultId, expiryId, MarginLevel.Maintenance)
        expect(maintenanceMargin).to.be.gt(depositAmount)

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, callId)

        expect(liqAmount).to.be.eq(amount)

        // liquidate
        const before = await usdc.balanceOf(liquidator.address)
        await optionVault.connect(liquidator).liquidate(vaultId, callId, liqAmount)
        const after = await usdc.balanceOf(liquidator.address)

        expect(after.sub(before)).to.be.gt(BASE_LIQ_REWARD)
      })

      it('liquidate a insolvency vault', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, callId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, callId, amount, '0x')

        // check and test flag insolvency vault
        await testContractHelper.updateSpot(scaledBN(1500, 8))

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, callId)
        expect(liqAmount).to.be.eq(amount)

        // liquidate
        const before = await usdc.balanceOf(liquidator.address)
        await optionVault.connect(liquidator).liquidate(vaultId, callId, amount)
        const after = await usdc.balanceOf(liquidator.address)

        // total amount of collateral is not changed
        const vault = await optionVault.getVault(vaultId, expiryId)
        expect(after.sub(before).add(vault.collateral)).to.be.eq(depositAmount)

        expect(after.sub(before)).to.be.eq(depositAmount)
      })

      it('reverts if the vault is not in liquidation zone', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, callId, amount, wallet.address)

        // check and test flag insolvency vault
        await testContractHelper.updateSpot(scaledBN(1200, 8))

        // liquidatable amount is 0
        expect(await optionVault.getLiquidatableAmount(vaultId, callId)).to.be.eq(0)

        // liquidate
        await expect(optionVault.liquidate(vaultId, callId, amount)).to.be.revertedWith(
          'OptionLib: collateral must be less than MM',
        )
      })
    })

    describe('put', async () => {
      it('reverts if amount is larger than burnable', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, putId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, putId, amount, '0x')

        const spot = scaledBN(595, 8)
        await testContractHelper.updateSpot(spot)

        // check vault's collateral is less than maintenance margin
        const maintenanceMargin = await optionVault.getRequiredMargin(vaultId, expiryId, MarginLevel.Maintenance)
        expect(maintenanceMargin).to.be.gt(depositAmount)

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, putId)
        console.log('liqAmount', liqAmount.toString())

        // liquidate
        await expect(optionVault.connect(liquidator).liquidate(vaultId, putId, liqAmount.add(1))).to.be.revertedWith(
          'OptionLib: amount exceeds liquidatable limit',
        )
      })

      it('liquidate a vault', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, putId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, putId, amount, '0x')

        const spot = scaledBN(595, 8)
        await testContractHelper.updateSpot(spot)

        // check vault's collateral is less than maintenance margin
        const maintenanceMargin = await optionVault.getRequiredMargin(vaultId, expiryId, MarginLevel.Maintenance)
        expect(maintenanceMargin).to.be.gt(depositAmount)

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, putId)

        const MIN_SIZE = scaledBN(1, 6)
        expect(liqAmount).to.be.lt(amount)
        expect(liqAmount).to.be.gt(MIN_SIZE)

        // liquidate
        const before = await usdc.balanceOf(liquidator.address)
        await optionVault.connect(liquidator).liquidate(vaultId, putId, liqAmount)
        const after = await usdc.balanceOf(liquidator.address)

        // total amount of collateral is not changed
        const vault = await optionVault.getVault(vaultId, expiryId)
        expect(after.sub(before).add(vault.collateral)).to.be.eq(depositAmount)

        expect(after.sub(before)).to.be.gt(spot.sub(initialSpot).mul(liqAmount).div(scaledBN(1, 10)))
      })

      it('liquidate all collateral of a vault', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, putId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, putId, amount, '0x')

        const spot = scaledBN(100, 8)
        await testContractHelper.updateSpot(spot)

        // check vault's collateral is less than maintenance margin
        const maintenanceMargin = await optionVault.getRequiredMargin(vaultId, expiryId, MarginLevel.Maintenance)
        expect(maintenanceMargin).to.be.gt(depositAmount)

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, putId)

        expect(liqAmount).to.be.eq(amount)

        // liquidate
        const before = await usdc.balanceOf(liquidator.address)
        await optionVault.connect(liquidator).liquidate(vaultId, putId, liqAmount)
        const after = await usdc.balanceOf(liquidator.address)

        expect(after.sub(before)).to.be.eq(depositAmount)
      })

      it('liquidate a insolvency vault', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, putId, amount, wallet.address)
        await optionVault.safeTransferFrom(wallet.address, liquidator.address, putId, amount, '0x')

        // check and test flag insolvency vault
        await testContractHelper.updateSpot(scaledBN(500, 8))

        const liqAmount = await optionVault.getLiquidatableAmount(vaultId, putId)
        expect(liqAmount).to.be.eq(amount)

        // liquidate
        const before = await usdc.balanceOf(liquidator.address)
        await optionVault.connect(liquidator).liquidate(vaultId, putId, amount)
        const after = await usdc.balanceOf(liquidator.address)

        // total amount of collateral is not changed
        const vault = await optionVault.getVault(vaultId, expiryId)
        expect(after.sub(before).add(vault.collateral)).to.be.eq(depositAmount)

        expect(after.sub(before)).to.be.eq(depositAmount)
      })

      it('reverts if the vault is not in liquidation zone', async () => {
        const amount = scaledBN(2, 8)

        await optionVault.write(vaultId, putId, amount, wallet.address)

        await testContractHelper.updateSpot(scaledBN(800, 8))

        // liquidatable amount is 0
        expect(await optionVault.getLiquidatableAmount(vaultId, putId)).to.be.eq(0)

        // liquidate
        await expect(optionVault.liquidate(vaultId, putId, amount)).to.be.revertedWith(
          'OptionLib: collateral must be less than MM',
        )
      })
    })

    it('liquidate a vault which writes 2 option serieses', async () => {
      const amount = scaledBN(1, 8)

      await optionVault.write(vaultId, callId, amount, wallet.address)
      await optionVault.safeTransferFrom(wallet.address, liquidator.address, callId, amount, '0x')

      await optionVault.write(vaultId, putId, amount, wallet.address)
      await optionVault.safeTransferFrom(wallet.address, liquidator.address, putId, amount, '0x')

      const spot = scaledBN(1810, 8)
      await testContractHelper.updateSpot(spot)

      // check vault's collateral is less than maintenance margin
      const maintenanceMargin = await optionVault.getRequiredMargin(vaultId, expiryId, MarginLevel.Maintenance)
      expect(maintenanceMargin).to.be.gt(depositAmount)

      const liqAmount = await optionVault.getLiquidatableAmount(vaultId, callId)

      expect(liqAmount).to.be.lte(amount)

      // liquidate
      await optionVault.connect(liquidator).liquidate(vaultId, callId, liqAmount)

      const afterLiqAmountCall = await optionVault.getLiquidatableAmount(vaultId, callId)
      const afterLiqAmountPut = await optionVault.getLiquidatableAmount(vaultId, putId)
      expect(afterLiqAmountCall).to.be.eq(0)
      expect(afterLiqAmountPut).to.be.eq(0)
    })

    it('reverts if amount is 0', async () => {
      const amount = scaledBN(2, 8)

      await optionVault.write(vaultId, callId, amount, wallet.address)

      // check and test flag insolvency vault
      await testContractHelper.updateSpot(scaledBN(1500, 8))

      // liquidate
      await expect(optionVault.liquidate(vaultId, callId, 0)).to.be.revertedWith(VaultErrors.AMOUNT_GT_0)
    })

    it('reverts if caller does not have options', async () => {
      const amount = scaledBN(2, 8)

      await optionVault.write(vaultId, callId, amount, wallet.address)

      // check and test flag insolvency vault
      await testContractHelper.updateSpot(scaledBN(1500, 8))

      // liquidate
      await expect(optionVault.connect(other).liquidate(vaultId, callId, amount)).to.be.revertedWith(
        VaultErrors.AMOUNT_EXCEED_BALANCE,
      )
    })
  })

  describe('calculateVaultDelta', () => {
    let expiryId: BigNumber
    let seriesId: BigNumber
    let vaultId: BigNumber
    let expiry: number
    const depositAmount = scaledBN(2000, 6)

    beforeEach(async () => {
      expiry = await getExpiry(7)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      seriesId = result.calls[0]

      vaultId = await testContractHelper.createAccount(wallet)

      // deposit usdc
      await usdc.approve(optionVault.address, depositAmount)
      await optionVault.deposit(vaultId, expiryId, depositAmount)
    })

    it('calculate vault delta', async () => {
      const amount = scaledBN(1, 8)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      const delta = await optionVault.calculateVaultDelta(vaultId, expiryId)

      expect(delta).to.be.lt(0)
    })

    it('calculate vault delta with has settled option series', async () => {
      const price = scaledBN(1100, 8)
      const amount = scaledBN(1, 8)

      await optionVault.write(vaultId, seriesId, amount, wallet.address)

      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(60 * 60 * 2)

      await optionVault.settleVault(vaultId, expiryId)

      const delta = await optionVault.calculateVaultDelta(vaultId, expiryId)

      expect(delta).to.be.eq(0)
    })
  })

  describe('getLiveOptionSerieses', () => {
    let expiryId: BigNumber
    let callId: BigNumber
    let putId: BigNumber
    let vaultId: BigNumber
    let expiry: number

    beforeEach(async () => {
      expiry = await getExpiry(7)
      const strike = scaledBN(1000, 8)
      const iv = scaledBN(100, 6)

      const result = await testContractHelper.createExpiry(expiry, [strike], [iv])
      expiryId = result.expiryId
      callId = result.calls[0]
      putId = result.puts[0]

      vaultId = await testContractHelper.createAccount(wallet)
    })

    it('get live option serieses', async () => {
      const serieses = await optionVault.getLiveOptionSerieses()

      expect(serieses).to.be.deep.eq([[expiryId, BigNumber.from(expiry), [callId, putId]]])
    })

    it('does not return settled series', async () => {
      const price = scaledBN(1100, 8)

      await setTime(expiry + 60)
      await testContractHelper.updateExpiryPrice(expiry, price)
      await increaseTime(60 * 60 * 2)

      await optionVault.settleVault(vaultId, expiryId)

      const serieses = await optionVault.getLiveOptionSerieses()

      expect(serieses).to.be.deep.eq([])
    })
  })

  describe('operator functions', () => {
    it('set base fee reward', async () => {
      const value = scaledBN(200, 6)

      await optionVault.setConfig(OptionVaultConfig.BASE_LIQ_REWARD, value)

      const result = await optionVault.getConfig(OptionVaultConfig.BASE_LIQ_REWARD)
      expect(result).to.be.eq(value)
    })

    it('setting base fee reward reverts if caller is not operator', async () => {
      const value = scaledBN(200, 6)

      await expect(optionVault.connect(other).setConfig(OptionVaultConfig.BASE_LIQ_REWARD, value)).to.be.revertedWith(
        VaultErrors.CALLER_MST_BE_OPERATOR,
      )
    })

    it('set new operator', async () => {
      const value = scaledBN(200, 6)

      // can not update operator except operator
      await expect(optionVault.connect(other).setNewOperator(other.address)).to.be.revertedWith(
        VaultErrors.CALLER_MST_BE_OPERATOR,
      )

      // set new operator as other.address
      await optionVault.setNewOperator(other.address)

      // new operator can call setConfig
      await optionVault.connect(other).setConfig(OptionVaultConfig.BASE_LIQ_REWARD, value)
      await expect(optionVault.setConfig(OptionVaultConfig.BASE_LIQ_REWARD, value)).to.be.revertedWith(
        VaultErrors.CALLER_MST_BE_OPERATOR,
      )
    })
  })
})
