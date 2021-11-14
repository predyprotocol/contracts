import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Wallet } from 'ethers'
import { getExpiry, scaledBN } from './utils/helpers'
import { FeePool, LendingPool, MockERC20, MockLendingPool, MockWETH, OptionLibTester } from '../typechain'
import { MarginLevel } from './constants'

describe('OptionLib', function () {
  let wallet: Wallet, other: Wallet
  let optionLibTester: any
  let feePool: FeePool
  let tester: OptionLibTester
  let weth: MockWETH
  let usdc: MockERC20
  let lendingPool: LendingPool

  before(async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    const MockWETH = await ethers.getContractFactory('MockWETH')
    const MockERC20 = await ethers.getContractFactory('MockERC20')

    weth = (await MockWETH.deploy('WETH', 'WETH', 18)) as MockWETH
    usdc = (await MockERC20.deploy('USDC', 'USDC', 6)) as MockERC20

    await weth.mint(wallet.address, scaledBN(10, 18))
    await usdc.mint(wallet.address, scaledBN(10000, 6))

    const MockLendingPool = await ethers.getContractFactory('MockLendingPool')
    lendingPool = (await MockLendingPool.deploy(usdc.address, weth.address)) as LendingPool

    await weth.mint(lendingPool.address, scaledBN(10, 18))

    const FeePool = await ethers.getContractFactory('FeePool')
    feePool = (await FeePool.deploy(usdc.address)) as FeePool

    const PriceCalculator = await ethers.getContractFactory('PriceCalculator')
    const priceCalculator = await PriceCalculator.deploy()

    const OptionLib = await ethers.getContractFactory('OptionLib', {
      libraries: {
        PriceCalculator: priceCalculator.address,
      },
    })
    const optionLib = await OptionLib.deploy()

    optionLibTester = await ethers.getContractFactory('OptionLibTester', {
      libraries: {
        OptionLib: optionLib.address,
      },
    })
  })

  beforeEach(async () => {
    tester = (await optionLibTester.deploy()) as OptionLibTester
    await tester.testInit(usdc.address, weth.address, lendingPool.address)
  })

  describe('getRequiredCollateral', () => {
    const accountId = 0
    const expiryId = 1
    const seriesIds = [2, 3]
    const spot = scaledBN(1010, 8)
    const strike = scaledBN(1000, 8)
    let expiry: number

    beforeEach(async () => {
      expiry = await getExpiry(1)

      await tester.testUpdateExpiration(expiryId, expiry, seriesIds)

      await tester.testUpdateSeries(seriesIds[0], strike, false, scaledBN(100, 6), expiryId)
      await tester.testUpdateSeries(seriesIds[1], strike, true, scaledBN(100, 6), expiryId)
    })

    it("get required collateral of long call in pool's vault", async () => {
      const size = scaledBN(2, 8)
      const expectedRequiredCollateral = strike.mul(size).mul(12).div(scaledBN(1, 11))

      await tester.testUpdateLong(expiryId, seriesIds[0], size)

      const requiredCollateral = await tester.testGetRequiredCollateral(accountId, expiryId, spot, MarginLevel.Safe)

      expect(requiredCollateral).to.be.eq(expectedRequiredCollateral)
    })

    it("get required collateral of long put in pool's vault", async () => {
      const size = scaledBN(2, 8)
      const expectedRequiredCollateral = spot.mul(size).mul(12).div(scaledBN(1, 11))

      await tester.testUpdateLong(expiryId, seriesIds[1], size)

      const requiredCollateral = await tester.testGetRequiredCollateral(accountId, expiryId, spot, MarginLevel.Safe)

      expect(requiredCollateral).to.be.eq(expectedRequiredCollateral)
    })

    it("get required collateral of short call in pool's vault", async () => {
      const size = scaledBN(2, 8)
      const expectedRequiredCollateral = spot.mul(size).mul(12).div(scaledBN(1, 11))

      await tester.testUpdateShort(expiryId, seriesIds[0], size)

      const requiredCollateral = await tester.testGetRequiredCollateral(accountId, expiryId, spot, MarginLevel.Safe)

      expect(requiredCollateral).to.be.eq(expectedRequiredCollateral)
    })

    it("get required collateral of short put in pool's vault", async () => {
      const size = scaledBN(2, 8)
      const expectedRequiredCollateral = strike.mul(size).mul(12).div(scaledBN(1, 11))

      await tester.testUpdateShort(expiryId, seriesIds[1], size)

      const requiredCollateral = await tester.testGetRequiredCollateral(accountId, expiryId, spot, MarginLevel.Safe)

      expect(requiredCollateral).to.be.eq(expectedRequiredCollateral)
    })

    it("get required collateral of short call in trader's vault", async () => {
      const size = scaledBN(2, 8)
      const full = spot.mul(size).div(scaledBN(1, 10))

      await tester.testUpdateShort(expiryId, seriesIds[0], size)

      const requiredCollateral = await tester.testGetRequiredCollateral(accountId, expiryId, spot, MarginLevel.Initial)

      expect(requiredCollateral).to.be.gt(full.div(5))
      expect(requiredCollateral).to.be.lt(full)
    })

    it("get required collateral of short put in trader's vault", async () => {
      const size = scaledBN(2, 8)
      const full = strike.mul(size).div(scaledBN(1, 10))

      await tester.testUpdateShort(expiryId, seriesIds[1], size)

      const requiredCollateral = await tester.testGetRequiredCollateral(accountId, expiryId, spot, MarginLevel.Initial)

      expect(requiredCollateral).to.be.gt(full.div(5))
      expect(requiredCollateral).to.be.lt(full)
    })
  })

  describe('testRedeemCollateralFromLendingPool', () => {
    it('repay full and redeem collateral', async () => {
      const repayAmout = scaledBN(1, 18)
      const depositAmount = scaledBN(1200, 6)
      const price = scaledBN(1000, 8)

      // deposit and borrow
      await usdc.approve(lendingPool.address, depositAmount)
      await lendingPool.deposit(usdc.address, depositAmount, tester.address, 0)

      await lendingPool.borrow(weth.address, repayAmout, 2, 0, tester.address)

      // repay full
      await weth.approve(tester.address, repayAmout)

      const beforeCaller = await usdc.balanceOf(wallet.address)
      const beforeFeePool = await usdc.balanceOf(feePool.address)
      await tester.testRedeemCollateralFromLendingPool(repayAmout, price, wallet.address, feePool.address)
      const afterCaller = await usdc.balanceOf(wallet.address)
      const afterFeePool = await usdc.balanceOf(feePool.address)

      // assertions
      const reward = repayAmout.mul(price).div(scaledBN(1, 20)).mul(1006).div(1000)

      expect(afterCaller.sub(beforeCaller)).to.be.eq(reward)
      expect(afterFeePool.sub(beforeFeePool)).to.be.eq(depositAmount.sub(reward))
    })
  })
})
