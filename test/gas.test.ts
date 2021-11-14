import { ethers } from 'hardhat'
import { expect } from 'chai'
import { AMM, MockERC20, OptionVault } from '../typechain'
import { BigNumber, Wallet } from 'ethers'
import { getExpiry, increaseTime, scaledBN, setTime } from './utils/helpers'
import {
  deployTestContractSet,
  restoreSnapshot,
  takeSnapshot,
  TestContractHelper,
  TestContractSet,
} from './utils/deploy'

describe('gas', function () {
  let wallet: Wallet, other: Wallet
  let weth: MockERC20
  let usdc: MockERC20
  let optionVault: OptionVault
  let amm: AMM
  let testContractSet: TestContractSet
  let testContractHelper: TestContractHelper
  let snapshotId: number
  let callIds14: BigNumber[] = []
  let putIds14: BigNumber[] = []
  let callIds28: BigNumber[] = []
  let putIds28: BigNumber[] = []
  let expiryId14: BigNumber
  let expiryId28: BigNumber
  let expiry: number

  const initialSpot = scaledBN(1000, 8)

  before(async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    testContractSet = await deployTestContractSet(wallet)
    testContractHelper = new TestContractHelper(testContractSet)

    weth = testContractSet.weth
    usdc = testContractSet.usdc
    optionVault = testContractSet.optionVault
    amm = testContractSet.amm

    await testContractHelper.updateSpot(initialSpot)

    const iv = scaledBN(110, 6)

    expiry = await getExpiry(14)
    const expiry28 = await getExpiry(28)

    const createdResult14 = await testContractHelper.createSeriesSet(expiry, iv, 5)
    const createdResult28 = await testContractHelper.createSeriesSet(expiry28, iv, 5)

    expiryId14 = createdResult14.expiryId
    putIds14 = createdResult14.puts
    callIds14 = createdResult14.calls

    expiryId28 = createdResult28.expiryId
    putIds28 = createdResult28.puts
    callIds28 = createdResult28.calls

    // mint 50 ETH
    const testAmount = scaledBN(50, 18)
    await weth.deposit({ value: testAmount })

    // mint 100,000 USDC
    const testUsdcAmount = scaledBN(100000, 6)
    await usdc.mint(wallet.address, testUsdcAmount)

    const tickLower = 10
    const tickUpper = 14
    const maxDepositAmount = scaledBN(40000, 6)

    await usdc.approve(amm.address, maxDepositAmount)
    await amm.deposit(maxDepositAmount, maxDepositAmount, tickLower, tickUpper)

    const maxFee = scaledBN(1000, 6)
    await usdc.approve(amm.address, maxFee.mul(24))

    // buy call options
    for (let id of callIds14) {
      await amm.buy(id, scaledBN(2, 7), maxFee)
    }

    // buy put options
    for (let id of putIds14) {
      await amm.buy(id, scaledBN(1, 7), maxFee)
    }

    // buy call options
    for (let id of callIds14) {
      await amm.buy(id, scaledBN(2, 6), maxFee)
    }

    // buy put options
    for (let id of putIds14) {
      await amm.buy(id, scaledBN(1, 6), maxFee)
    }
  })

  beforeEach(async () => {
    snapshotId = await takeSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot(snapshotId)
  })

  describe('delta hedge', () => {
    it('gas usage of hedge 20 serieses [ @skip-on-coverage ]', async () => {
      const tickId = 11

      const price = scaledBN(1257, 8)
      await testContractHelper.updateSpot(price)

      const beforeHedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId14)

      const beforeTickDelta = await testContractHelper.getTickDelta(tickId, expiryId14)

      const longSize = beforeTickDelta.abs()

      await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))
      const tx = await optionVault.addUnderlyingLong(
        tickId,
        expiryId14,
        longSize,
        longSize.mul(price).div(scaledBN(1, 10)),
      )
      const receipt = await tx.wait()
      const afterHedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId14)

      expect(beforeHedgePosition).to.be.eq(BigNumber.from(0))
      expect(afterHedgePosition.gt(beforeHedgePosition)).to.be.true

      const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId14)
      const totalDelta = tickDelta.add(afterHedgePosition)

      expect(totalDelta).to.be.eq(0)

      expect(receipt.gasUsed).to.be.lt(530000)
    })
  })

  it('gas usage of buying [ @skip-on-coverage ]', async () => {
    const seriesId = putIds14[0]

    const amount = scaledBN(1, 7)
    const maxFee = scaledBN(1000, 6)

    const price = scaledBN(1070, 8)
    await testContractHelper.updateSpot(price)

    console.log((await testContractHelper.getIV(seriesId)).toString())

    await usdc.approve(amm.address, maxFee)
    const tx = await amm.buy(seriesId, amount, maxFee)
    const receipt = await tx.wait()

    console.log((await testContractHelper.getIV(seriesId)).toString())

    expect(receipt.gasUsed).to.be.lt(360000)
  })

  it('gas usage of buying(long to short tick) [ @skip-on-coverage ]', async () => {
    const seriesId = putIds14[0]

    const amount = scaledBN(5, 7)
    const minFee = 0

    const price = scaledBN(1070, 8)
    await testContractHelper.updateSpot(price)

    const vaultId = await testContractHelper.createAccount(wallet)

    // deposit usdc to the vault
    const collateral = scaledBN(1000, 6)
    await usdc.approve(optionVault.address, collateral)
    await optionVault.deposit(vaultId, expiryId14, collateral)
    await optionVault.write(vaultId, seriesId, amount, wallet.address)

    // sell options
    await optionVault.connect(wallet).setApprovalForAll(amm.address, true)

    await amm.sell(seriesId, amount, minFee)

    const maxFee = scaledBN(1000, 6)

    expect(await testContractHelper.getIV(seriesId)).to.be.lt(110000000)

    await usdc.approve(amm.address, maxFee)
    const tx = await amm.buy(seriesId, amount, maxFee)
    const receipt = await tx.wait()

    expect(await testContractHelper.getIV(seriesId)).to.be.gt(110000000)

    expect(receipt.gasUsed).to.be.lt(600000)
  })

  it('gas usage of selling(short tick) [ @skip-on-coverage ]', async () => {
    const seriesId = putIds14[0]

    const amount = scaledBN(2, 6)
    const minFee = 0

    const price = scaledBN(1070, 8)
    await testContractHelper.updateSpot(price)

    const tx = await amm.sell(seriesId, amount, minFee)
    const receipt = await tx.wait()

    expect(receipt.gasUsed).to.be.lt(480000)
  })

  it('gas usage of selling(short to long tick) [ @skip-on-coverage ]', async () => {
    const seriesId = putIds14[0]

    const amount = scaledBN(5, 7)
    const minFee = 0

    const price = scaledBN(1070, 8)
    await testContractHelper.updateSpot(price)

    const vaultId = await testContractHelper.createAccount(wallet)

    // deposit usdc to the vault
    const collateral = scaledBN(1000, 6)
    await usdc.approve(optionVault.address, collateral)
    await optionVault.deposit(vaultId, expiryId14, collateral)
    await optionVault.write(vaultId, seriesId, amount, wallet.address)

    // sell options
    await optionVault.connect(wallet).setApprovalForAll(amm.address, true)

    const tx = await amm.sell(seriesId, amount, minFee)
    const receipt = await tx.wait()

    expect(receipt.gasUsed).to.be.lt(840000)
  })

  it('gas usage of makeShortPosition [ @skip-on-coverage ]', async () => {
    const seriesId = putIds14[0]

    const amount = scaledBN(2, 6)

    const price = scaledBN(1070, 8)
    await testContractHelper.updateSpot(price)

    // deposit usdc to the vault
    const collateral = scaledBN(1000, 6)
    await usdc.approve(optionVault.address, collateral)

    const tx = await optionVault.makeShortPosition(0, seriesId, scaledBN(1, 6), amount, 0)

    const receipt = await tx.wait()

    expect(receipt.gasUsed).to.be.lt(700000)
  })

  it('gas usage of write [ @skip-on-coverage ]', async () => {
    const seriesId = putIds14[0]

    const amount = scaledBN(2, 6)

    const price = scaledBN(1070, 8)
    await testContractHelper.updateSpot(price)

    const vaultId = await testContractHelper.createAccount(wallet)

    // deposit usdc to the vault
    const collateral = scaledBN(1000, 6)
    await usdc.approve(optionVault.address, collateral)
    await optionVault.deposit(vaultId, expiryId14, collateral)
    const tx = await optionVault.write(vaultId, seriesId, amount, wallet.address)

    const receipt = await tx.wait()

    expect(receipt.gasUsed).to.be.lt(400000)
  })

  it('gas usage of settlement [ @skip-on-coverage ]', async () => {
    const seriesId = putIds14[0]

    // $1020
    const price = scaledBN(1050, 8)

    // expiration passed
    await setTime(expiry + 60)
    await testContractHelper.updateExpiryPrice(expiry, price)
    await increaseTime(60 * 60 * 2)

    // await optionVault.updateExpiredCount(seriesId)

    // settlement
    const tx = await amm.settle(expiryId14)

    const receipt = await tx.wait()

    expect(receipt.gasUsed).to.be.lt(1400000)
  })

  it('gas usage of liquidation [ @skip-on-coverage ]', async () => {
    const seriesId1 = callIds14[0]
    const seriesId2 = callIds14[1]

    const amount = scaledBN(10, 7)

    const price = scaledBN(1070, 8)
    await testContractHelper.updateSpot(price)

    const vaultId = await testContractHelper.createAccount(wallet)

    // deposit usdc to the vault
    const collateral = scaledBN(700, 6)
    await usdc.approve(optionVault.address, collateral)
    await optionVault.deposit(vaultId, expiryId14, collateral)
    await optionVault.write(vaultId, seriesId1, amount, wallet.address)
    await optionVault.write(vaultId, seriesId2, amount, wallet.address)

    await testContractHelper.updateSpot(scaledBN(1400, 8))

    const liqAmount = await optionVault.getLiquidatableAmount(vaultId, seriesId1)

    const tx = await optionVault.liquidate(vaultId, seriesId1, liqAmount)

    const receipt = await tx.wait()

    expect(receipt.gasUsed).to.be.lt(340000)
  })
})
