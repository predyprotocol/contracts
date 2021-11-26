import { ethers } from 'hardhat'
import { expect } from 'chai'
import { AMMLibTester } from '../typechain/AMMLibTester'
import { BigNumber, Wallet } from 'ethers'
import { scaledBN } from './utils/helpers'

export interface Tick {
  supply: BigNumber
  balance: BigNumber
  lastSupply: BigNumber
  lastBalance: BigNumber
  secondsPerLiquidity: BigNumber
  burnReserved: BigNumber
  reservationForWithdrawal: BigNumber
}

export function decodeTick(result: any): Tick {
  return {
    supply: result[0],
    balance: result[1],
    lastSupply: result[2],
    lastBalance: result[3],
    secondsPerLiquidity: result[4],
    burnReserved: result[5],
    reservationForWithdrawal: result[6],
  }
}

describe('AMMLib', function () {
  let wallet: Wallet, other: Wallet
  let ammLibTester: any
  let tester: AMMLibTester
  const spot = scaledBN(1002, 8)

  async function getTick(index: number): Promise<Tick> {
    return decodeTick(await tester.ticks(index))
  }

  const addBalance = async (range: { start: number; end: number }, amount: BigNumber) => {
    const share = await tester.getMintAmount(range.start, range.end, amount)
    await tester.addBalance(range.start, range.end, share)
    return share
  }
  const removeBalance = async (range: { start: number; end: number }, amount: BigNumber) => {
    await tester.removeBalance(range.start, range.end, amount)
  }

  async function getBalance(s: number, e: number) {
    let balance = BigNumber.from(0)
    for (let i = s; i < e; i++) {
      const tick = await getTick(i)
      balance = balance.add(tick.balance)
    }
    return balance
  }

  before(async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    const PriceCalculator = await ethers.getContractFactory('PriceCalculator')
    const priceCalculator = await PriceCalculator.deploy()

    const AMMLib = await ethers.getContractFactory('AMMLib', {
      libraries: {
        PriceCalculator: priceCalculator.address,
      },
    })
    const ammLib = await AMMLib.deploy()

    ammLibTester = await ethers.getContractFactory('AMMLibTester', {
      libraries: {
        AMMLib: ammLib.address,
      },
    })
  })

  beforeEach(async () => {
    tester = (await ammLibTester.deploy()) as AMMLibTester
  })

  afterEach(async () => {
    await tester.clear()
  })

  describe('addBalance', () => {
    const rangeA = { start: 0, end: 10 }
    const rangeB = { start: 5, end: 15 }
    const decimals = 8
    const amount = scaledBN(10, decimals)

    it('initial addBalance', async () => {
      const mint = await tester.getMintAmount(rangeA.start, rangeA.end, amount)
      await tester.addBalance(rangeA.start, rangeA.end, mint)
      const mintAfter = await tester.getMintAmount(rangeA.start, rangeA.end, amount)

      expect(mint).to.be.eq(mintAfter)

      const withdrawableAmount = await tester.getWithdrawableAmount(rangeA.start, rangeA.end, mint)

      expect(withdrawableAmount).to.be.eq(amount)

      // clean
      await tester.removeBalance(rangeA.start, rangeA.end, amount)
    })

    it('addBalance after addBalance', async () => {
      const mintA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)
      await tester.addBalance(rangeA.start, rangeA.end, amount)

      const mintB = await tester.getMintAmount(rangeB.start, rangeB.end, amount)
      await tester.addBalance(rangeB.start, rangeB.end, amount)

      const mintAAfter = await tester.getMintAmount(rangeA.start, rangeA.end, amount)

      expect(mintA).to.be.eq(mintB)
      expect(mintA).to.be.eq(mintAAfter)

      // clean
      await tester.removeBalance(rangeA.start, rangeA.end, amount)
      await tester.removeBalance(rangeB.start, rangeB.end, amount)
    })

    it('addBalance after getting premium but locked', async () => {
      const premium = scaledBN(1, decimals)
      await tester.addBalance(rangeA.start, rangeA.end, amount)

      // get premium
      await tester.testAddProfit(5, premium)
      await tester.makeSnapshot(5)

      const beforeMintA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)
      await tester.addBalance(rangeB.start, rangeB.end, amount)
      const afterMintA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)

      expect(beforeMintA).to.be.eq(afterMintA)

      // clean
      await tester.removeBalance(rangeB.start, rangeB.end, amount)
      const balanceA = await tester.getMintAmount(rangeA.start, rangeA.end, amount.add(premium))
      await tester.removeBalance(rangeA.start, rangeA.end, balanceA)
    })

    it('addBalance after getting premium', async () => {
      const premium = scaledBN(1, decimals)
      await tester.addBalance(rangeA.start, rangeA.end, amount)

      // get premium
      await tester.testAddProfit(5, premium)

      const beforeMintA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)
      await tester.addBalance(rangeB.start, rangeB.end, amount)
      const afterMintA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)

      expect(beforeMintA).to.be.eq(afterMintA)

      // clean
      await tester.removeBalance(rangeA.start, rangeA.end, amount)
      await tester.removeBalance(rangeB.start, rangeB.end, amount)
    })

    it('addBalance after payout', async () => {
      const payout = scaledBN(10, 6)
      await tester.addBalance(rangeA.start, rangeA.end, amount)

      // get premium
      await tester.testAddLoss(5, payout)
      await tester.makeSnapshot(5)

      const beforeMintA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)
      await tester.addBalance(rangeB.start, rangeB.end, amount)
      const afterMintA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)

      expect(beforeMintA).to.be.eq(afterMintA)

      // clean
      const balanceA = await tester.getMintAmount(rangeA.start, rangeA.end, amount.sub(payout))
      await tester.removeBalance(rangeA.start, rangeA.end, balanceA)
      await tester.removeBalance(rangeB.start, rangeB.end, amount)
    })

    it('reverts because mint amount is not multiples of range length', async () => {
      await expect(tester.addBalance(rangeA.start, rangeA.end, amount.sub(1))).to.be.revertedWith(
        'PoolLib: mint is not multiples of range length',
      )
    })
  })

  describe('removeBalance', () => {
    const rangeA = { start: 0, end: 10 }
    const rangeB = { start: 5, end: 15 }
    const decimals = 8
    const amount = scaledBN(10, decimals)

    it('remove balance after add balance', async () => {
      await addBalance(rangeA, amount)

      const beforeBalance = await getBalance(rangeA.start, rangeA.end)
      await removeBalance(rangeA, amount)
      const afterBalance = await getBalance(rangeA.start, rangeA.end)

      expect(beforeBalance.sub(afterBalance)).to.be.eq(amount)
    })

    it('remove balance after getting premium in rangeA', async () => {
      const premium = scaledBN(1, decimals)

      await addBalance(rangeA, amount)
      await addBalance(rangeB, amount)

      // get premium
      await tester.testAddProfit(3, premium)
      await tester.makeSnapshot(3)

      const beforeBalance = await getBalance(rangeA.start, rangeB.end)
      const beforeShareA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)
      await tester.removeBalance(rangeA.start, rangeA.end, amount.div(2))
      await tester.removeBalance(rangeB.start, rangeB.end, amount.div(2))
      const afterShareA = await tester.getMintAmount(rangeA.start, rangeA.end, amount)

      expect(beforeShareA).to.be.eq(afterShareA)

      // clean
      await tester.removeBalance(rangeA.start, rangeA.end, amount.div(2))
      await tester.removeBalance(rangeB.start, rangeB.end, amount.div(2))

      const afterBalance = await getBalance(rangeA.start, rangeB.end)
      expect(beforeBalance.sub(afterBalance)).to.be.eq(amount.add(amount).add(premium))
    })

    it('remove balance after getting premium in intersection of rangeA and rangeB', async () => {
      const premium = scaledBN(1, decimals)

      await tester.addBalance(rangeA.start, rangeA.end, amount)
      await tester.addBalance(rangeB.start, rangeB.end, amount)

      // get premium
      await tester.testAddProfit(6, premium)
      await tester.makeSnapshot(6)

      const beforeBalance = await getBalance(rangeA.start, rangeB.end)

      await tester.removeBalance(rangeA.start, rangeA.end, amount)
      await tester.removeBalance(rangeB.start, rangeB.end, amount)

      const afterBalance = await getBalance(rangeA.start, rangeB.end)
      expect(beforeBalance.sub(afterBalance)).to.be.eq(amount.add(amount).add(premium))
    })

    it('remove balance after getting premium in rangeB', async () => {
      const premium = scaledBN(1, decimals)

      await addBalance(rangeA, amount)
      await addBalance(rangeB, amount)

      // get premium
      await tester.testAddProfit(12, premium)
      await tester.makeSnapshot(12)

      const beforeBalance = await getBalance(rangeA.start, rangeB.end)
      await tester.removeBalance(rangeA.start, rangeA.end, amount)
      await tester.removeBalance(rangeB.start, rangeB.end, amount)
      const afterBalance = await getBalance(rangeA.start, rangeB.end)

      // assertions
      expect(beforeBalance.sub(afterBalance)).to.be.eq(amount.add(amount).add(premium))
    })

    it('reverts if remove large amount of balance', async () => {
      await tester.addBalance(rangeA.start, rangeA.end, amount)
      await expect(tester.removeBalance(rangeA.start, rangeA.end, amount.add(50))).to.be.revertedWith(
        'AMMLib: no enough balance to withdraw',
      )
    })

    it('reverts because burn amount is not multiples of range lengtht', async () => {
      await tester.addBalance(rangeA.start, rangeA.end, amount)
      await expect(tester.removeBalance(rangeA.start, rangeA.end, amount.sub(1))).to.be.revertedWith(
        'PoolLib: burn is not multiples of range length',
      )
    })
  })
})
