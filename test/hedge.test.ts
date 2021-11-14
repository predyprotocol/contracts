import { ethers } from 'hardhat'
import { expect } from 'chai'
import { AMM, MockERC20, OptionVault } from '../typechain'
import { BigNumber, Wallet } from 'ethers'
import { getExpiry, increaseTime, scaledBN, setTime } from './utils/helpers'
import { DISPUTE_PERIOD } from './constants'
import {
  deployTestContractSet,
  restoreSnapshot,
  takeSnapshot,
  TestContractHelper,
  TestContractSet,
} from './utils/deploy'

describe('Hedge', function () {
  let wallet: Wallet, other: Wallet
  let weth: MockERC20
  let usdc: MockERC20
  let optionVault: OptionVault
  let amm: AMM
  let testContractSet: TestContractSet
  let testContractHelper: TestContractHelper
  let snapshotId: number

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
  })

  beforeEach(async () => {
    snapshotId = await takeSnapshot()

    // mint 50 ETH
    const testAmount = scaledBN(50, 18)
    await weth.deposit({ value: testAmount })

    // mint 100,000 USDC
    const testUsdcAmount = scaledBN(100000, 6)
    await usdc.mint(wallet.address, testUsdcAmount)

    const tickLower = 10
    const tickUpper = 12
    const maxDepositAmount = scaledBN(40000, 6)

    await usdc.approve(amm.address, maxDepositAmount)
    await amm.deposit(maxDepositAmount, maxDepositAmount, tickLower, tickUpper)
  })

  afterEach(async () => {
    await restoreSnapshot(snapshotId)
  })

  describe('hedge', () => {
    const tickId = 10

    async function hedge(tickId: number, expiryId: BigNumber, price: BigNumber) {
      const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId)
      const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId)
      const netDelta = tickDelta.add(hedgePosition)

      if (netDelta.isNegative()) {
        const longSize = netDelta.abs()
        const usdcAmount = longSize.mul(price).div(scaledBN(1, 10))

        await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))

        const before = await usdc.balanceOf(wallet.address)
        await optionVault.addUnderlyingLong(tickId, expiryId, longSize, usdcAmount)
        const after = await usdc.balanceOf(wallet.address)

        expect(after.sub(before)).to.be.gte(usdcAmount)
      } else {
        const shortSize = netDelta.abs()

        const usdcAmount = shortSize.mul(price).div(scaledBN(1, 10))
        await usdc.approve(optionVault.address, usdcAmount)

        const before = await weth.balanceOf(wallet.address)
        await optionVault.addUnderlyingShort(tickId, expiryId, shortSize, usdcAmount)
        const after = await weth.balanceOf(wallet.address)

        expect(after.sub(before)).to.be.gte(shortSize.mul(scaledBN(1, 10)))
      }
    }

    it('calculate gas cost of hedge 24 serieses', async () => {
      let callIds: BigNumber[] = []
      let putIds: BigNumber[] = []

      const expiry7 = await getExpiry(7)
      const expiry14 = await getExpiry(14)
      const expiry21 = await getExpiry(21)
      const expiry28 = await getExpiry(28)

      const result7 = await testContractHelper.createSeriesSet(expiry7)
      const result14 = await testContractHelper.createSeriesSet(expiry14)
      const result21 = await testContractHelper.createSeriesSet(expiry21)
      const result28 = await testContractHelper.createSeriesSet(expiry28)

      const expiryId7 = result7.expiryId
      const expiryId14 = result14.expiryId
      const expiryId21 = result21.expiryId
      const expiryId28 = result28.expiryId

      const callIds7 = result7.calls
      const putIds7 = result7.puts
      const callIds14 = result14.calls
      const putIds14 = result14.puts
      const callIds21 = result21.calls
      const putIds21 = result21.puts
      const callIds28 = result28.calls
      const putIds28 = result28.puts

      const maxFee = scaledBN(1000, 6)
      await usdc.approve(amm.address, maxFee.mul(24))

      // buy call options
      for (let id of callIds7) {
        await amm.buy(id, scaledBN(2, 7), maxFee)
      }

      // buy put options
      for (let id of putIds7) {
        await amm.buy(id, scaledBN(1, 7), maxFee)
      }

      const price = scaledBN(1050, 8)
      await testContractHelper.updateSpot(price)

      const beforeHedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId7)

      const beforeTickDelta = await testContractHelper.getTickDelta(tickId, expiryId7)

      const longSize = beforeTickDelta.abs()

      await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))
      await optionVault.addUnderlyingLong(tickId, expiryId7, longSize, longSize.mul(price).div(scaledBN(1, 10)))
      const afterHedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId7)

      expect(beforeHedgePosition).to.be.eq(BigNumber.from(0))
      expect(afterHedgePosition.gt(beforeHedgePosition)).to.be.true

      const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId7)
      const totalDelta = tickDelta.add(afterHedgePosition)

      expect(totalDelta).to.be.eq(0)
    })

    describe('tick delta is negative', () => {
      let expiry20: number
      let expiryId20: BigNumber
      let callIds: BigNumber[] = []
      let putIds: BigNumber[] = []
      let beforeTickDelta: BigNumber

      beforeEach(async () => {
        expiry20 = await getExpiry(20)

        const result = await testContractHelper.createSeriesSet(expiry20)

        expiryId20 = result.expiryId
        callIds = result.calls
        putIds = result.puts

        await testContractHelper.updateSpot(scaledBN(1000, 8))

        const maxFee = scaledBN(1000, 6)
        await usdc.approve(amm.address, maxFee.mul(3))

        // buy call options
        for (let id of callIds) {
          await amm.buy(id, scaledBN(1, 8), maxFee)
        }

        const price = scaledBN(1050, 8)
        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        beforeTickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = beforeTickDelta.add(hedgePosition)

        expect(beforeTickDelta).to.be.lt(0)
        expect(totalDelta).to.be.eq(0)

        // check hedge contract holds underlying asset
        const wethBalance = await weth.balanceOf(optionVault.address)
        expect(wethBalance).to.be.eq(hedgePosition.mul(scaledBN(1, 10)))
      })

      it('reverts if add short when net delta is negative', async () => {
        const price = scaledBN(1060, 8)

        await testContractHelper.updateSpot(price)

        await expect(optionVault.addUnderlyingShort(tickId, expiryId20, 1, 1)).to.be.revertedWith(
          'OptionLib: net delta must be positive',
        )
      })

      it('add short reverts if amount is too large', async () => {
        const price = scaledBN(930, 8)

        await testContractHelper.updateSpot(price)

        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const netDelta = tickDelta.add(hedgePosition)
        const longSize = netDelta.abs().add(1).mul(scaledBN(1, 10))
        const usdcAmount = longSize.mul(price).div(scaledBN(1, 20))

        await weth.approve(optionVault.address, longSize)

        await expect(optionVault.addUnderlyingShort(tickId, expiryId20, longSize, usdcAmount)).to.be.revertedWith(
          'OptionLib: underlying amount is too large',
        )
      })

      it('add long reverts if amount is too large', async () => {
        const price = scaledBN(1075, 8)

        await testContractHelper.updateSpot(price)

        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const netDelta = tickDelta.add(hedgePosition)
        const longSize = netDelta.abs().add(1)
        const usdcAmount = longSize.mul(price).div(scaledBN(1, 10))

        await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))

        await expect(optionVault.addUnderlyingLong(tickId, expiryId20, longSize, usdcAmount)).to.be.revertedWith(
          'OptionLib: underlying amount is too large',
        )
      })

      it('reverts if collateral amount is too small', async () => {
        const price = scaledBN(930, 8)

        await testContractHelper.updateSpot(price)

        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const netDelta = tickDelta.add(hedgePosition)
        const longSize = netDelta.abs()
        let usdcAmount = longSize.mul(price).div(scaledBN(1, 10))
        usdcAmount = usdcAmount.mul(99).div(100)

        await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))

        await expect(optionVault.addUnderlyingShort(tickId, expiryId20, longSize, usdcAmount)).to.be.revertedWith(
          'OptionLib: collateral amount is too small',
        )
      })

      it('reverts if collateral amount is too large', async () => {
        const price = scaledBN(1075, 8)

        await testContractHelper.updateSpot(price)

        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const netDelta = tickDelta.add(hedgePosition)
        const longSize = netDelta.abs()
        let usdcAmount = longSize.mul(price).div(scaledBN(1, 10))
        usdcAmount = usdcAmount.mul(101).div(100)

        await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))

        await expect(optionVault.addUnderlyingLong(tickId, expiryId20, longSize, usdcAmount)).to.be.revertedWith(
          'OptionLib: collateral amount is too large',
        )
      })

      it('tick delta is changed a little', async () => {
        const price = scaledBN(1051, 8)
        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        // assertions
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = tickDelta.add(hedgePosition)

        expect(tickDelta).to.be.lt(beforeTickDelta)
        expect(totalDelta).to.be.eq(0)
      })

      it('tick delta is increased to negative', async () => {
        const price = scaledBN(1005, 8)

        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        // assertions
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = tickDelta.add(hedgePosition)

        expect(tickDelta).to.be.gt(beforeTickDelta)
        expect(totalDelta).to.be.eq(0)
      })

      it('tick delta is increased to positive', async () => {
        const maxFee = scaledBN(1000, 6)
        await usdc.approve(amm.address, maxFee.mul(3))

        // buy put options
        for (let id of putIds) {
          await amm.buy(id, scaledBN(1, 8), maxFee)
        }

        const price = scaledBN(940, 8)

        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        // assertions
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = tickDelta.add(hedgePosition)

        expect(tickDelta).to.be.gt(beforeTickDelta)
        expect(totalDelta).to.be.eq(0)
      })

      it('tick delta is decreased to negative', async () => {
        const price = scaledBN(1100, 8)

        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        // assertions
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = tickDelta.add(hedgePosition)

        expect(tickDelta).to.be.lt(beforeTickDelta)
        expect(totalDelta).to.be.eq(0)
      })
    })

    describe('tick delta is positive', () => {
      let expiry20: number
      let expiryId20: BigNumber
      let callIds: BigNumber[] = []
      let putIds: BigNumber[] = []
      let beforeTickDelta: BigNumber

      beforeEach(async () => {
        expiry20 = await getExpiry(20)

        const result = await testContractHelper.createSeriesSet(expiry20)

        expiryId20 = result.expiryId
        callIds = result.calls
        putIds = result.puts

        const maxFee = scaledBN(1000, 6)
        await usdc.approve(amm.address, maxFee.mul(3))

        // buy call options
        for (let id of putIds) {
          await amm.buy(id, scaledBN(1, 8), maxFee)
        }

        const price = scaledBN(940, 8)

        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        beforeTickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = beforeTickDelta.add(hedgePosition)

        expect(beforeTickDelta).to.be.gt(0)
        expect(totalDelta).to.be.eq(0)
      })

      it('reverts if add long when net delta is positive', async () => {
        const price = scaledBN(930, 8)

        await testContractHelper.updateSpot(price)

        await expect(optionVault.addUnderlyingLong(tickId, expiryId20, 1, 1)).to.be.revertedWith(
          'OptionLib: net delta must be negative',
        )
      })

      it('add long reverts if amount is too large', async () => {
        const price = scaledBN(1025, 8)

        await testContractHelper.updateSpot(price)

        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const netDelta = tickDelta.add(hedgePosition)
        const longSize = netDelta.abs().add(1)
        const usdcAmount = longSize.mul(price).div(scaledBN(1, 10))

        await usdc.approve(optionVault.address, usdcAmount)

        await expect(optionVault.addUnderlyingLong(tickId, expiryId20, longSize, usdcAmount)).to.be.revertedWith(
          'OptionLib: underlying amount is too large',
        )
      })

      it('add short reverts if amount is too large', async () => {
        const price = scaledBN(930, 8)

        await testContractHelper.updateSpot(price)

        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const netDelta = tickDelta.add(hedgePosition)
        const shortSize = netDelta.abs().add(1)
        const usdcAmount = shortSize.mul(price).div(scaledBN(1, 10))

        await usdc.approve(optionVault.address, usdcAmount)

        await expect(optionVault.addUnderlyingShort(tickId, expiryId20, shortSize, usdcAmount)).to.be.revertedWith(
          'OptionLib: underlying amount is too large',
        )
      })

      it('reverts if collateral amount is too small', async () => {
        const price = scaledBN(930, 8)

        await testContractHelper.updateSpot(price)

        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const netDelta = tickDelta.add(hedgePosition)
        const longSize = netDelta.abs()
        let usdcAmount = longSize.mul(price).div(scaledBN(1, 10))
        usdcAmount = usdcAmount.mul(99).div(100)

        await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))

        await expect(optionVault.addUnderlyingShort(tickId, expiryId20, longSize, usdcAmount)).to.be.revertedWith(
          'OptionLib: collateral amount is too small',
        )
      })

      it('reverts if collateral amount is too large', async () => {
        const price = scaledBN(1025, 8)

        await testContractHelper.updateSpot(price)

        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const netDelta = tickDelta.add(hedgePosition)
        const longSize = netDelta.abs()
        let usdcAmount = longSize.mul(price).div(scaledBN(1, 10))
        usdcAmount = usdcAmount.mul(101).div(100)

        await weth.approve(optionVault.address, longSize.mul(scaledBN(1, 10)))

        await expect(optionVault.addUnderlyingLong(tickId, expiryId20, longSize, usdcAmount)).to.be.revertedWith(
          'OptionLib: collateral amount is too large',
        )
      })

      it('tick delta is changed a little', async () => {
        const price = scaledBN(939, 8)

        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        // assertions
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = tickDelta.add(hedgePosition)

        expect(tickDelta).to.be.gt(beforeTickDelta)
        expect(totalDelta).to.be.eq(0)
      })

      it('tick delta is increased to positive', async () => {
        const price = scaledBN(700, 8)

        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        // assertions
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = tickDelta.add(hedgePosition)

        expect(tickDelta).to.be.gt(beforeTickDelta)
        expect(totalDelta).to.be.eq(0)

        // check the protocol can redeem remain collaterals from Compound Protocol
        await setTime(expiry20 + 60)
        await testContractHelper.updateExpiryPrice(expiry20, price)
        await increaseTime(DISPUTE_PERIOD)
        await hedge(tickId, expiryId20, price)

        const vault = await optionVault.getVault(tickId, expiryId20)
        expect(vault.shortLiquidity).to.be.eq(0)
      })

      it('tick delta is decreased to negative', async () => {
        const maxFee = scaledBN(1000, 6)
        await usdc.approve(amm.address, maxFee.mul(3))

        // buy call options
        for (let id of callIds) {
          await amm.buy(id, scaledBN(2, 8), maxFee)
        }

        const price = scaledBN(1050, 8)
        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        // assertions
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = tickDelta.add(hedgePosition)

        expect(tickDelta).to.be.lt(beforeTickDelta)
        expect(totalDelta).to.be.eq(0)

        const vault = await testContractHelper.getVault(tickId, expiryId20)
        expect(vault.shortLiquidity).to.be.eq(0)
      })

      it('tick delta is decreased to positive', async () => {
        const price = scaledBN(1100, 8)

        await testContractHelper.updateSpot(price)

        await hedge(tickId, expiryId20, price)

        // assertions
        const tickDelta = await testContractHelper.getTickDelta(tickId, expiryId20)
        const hedgePosition = await testContractHelper.getHedgePosition(tickId, expiryId20)
        const totalDelta = tickDelta.add(hedgePosition)

        expect(tickDelta).to.be.lt(beforeTickDelta)
        expect(totalDelta).to.be.eq(0)
      })
    })
  })

  describe('calculateVaultDelta', () => {
    const tickId = 10
    let expiry7: number
    let expiry21: number
    let expiryId7: BigNumber
    let expiryId21: BigNumber
    let callIds7: BigNumber[]
    let callIds21: BigNumber[]

    beforeEach(async () => {
      expiry7 = await getExpiry(7)
      expiry21 = await getExpiry(21)

      const result7 = await testContractHelper.createSeriesSet(expiry7)
      const result21 = await testContractHelper.createSeriesSet(expiry21)

      expiryId7 = result7.expiryId
      callIds7 = result7.calls

      expiryId21 = result21.expiryId
      callIds21 = result21.calls

      const maxFee = scaledBN(1000000, 6)
      await usdc.approve(amm.address, maxFee.mul(6))

      // buy call options
      for (let id of callIds7) {
        await amm.buy(id, scaledBN(2, 7), maxFee)
      }

      for (let id of callIds21) {
        await amm.buy(id, scaledBN(2, 7), maxFee)
      }
    })

    it('calculate tick delta of 6 serieses', async () => {
      await testContractHelper.updateSpot(scaledBN(1050, 8))

      const delta = await optionVault.calculateVaultDelta(tickId, expiryId7)

      expect(delta.lt(0)).to.be.true
    })

    it('calculate tick delta of 3 serieses', async () => {
      await setTime(expiry7 + 60)

      await testContractHelper.updateExpiryPrice(expiry7, scaledBN(1050, 8))

      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId7)

      const delta = await optionVault.calculateVaultDelta(tickId, expiryId21)

      expect(delta.lt(0)).to.be.true
    })

    it('calculate tick delta of 0 serieses', async () => {
      await setTime(expiry7 + 60)

      await testContractHelper.updateExpiryPrice(expiry7, scaledBN(1050, 8))

      await setTime(expiry21 + 60)

      await testContractHelper.updateExpiryPrice(expiry21, scaledBN(1050, 8))

      await increaseTime(DISPUTE_PERIOD)

      await amm.settle(expiryId7)
      await amm.settle(expiryId21)

      const delta = await optionVault.calculateVaultDelta(tickId, expiryId21)

      expect(delta).to.be.eq(0)
    })
  })
})
