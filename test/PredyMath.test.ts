import { ethers } from 'hardhat'
import { expect } from 'chai'
import { PredyMathTester } from '../typechain/PredyMathTester'
import { BigNumber, Wallet } from 'ethers'
import { scaledBN } from './utils/helpers'

describe('PredyMath', function () {
  let wallet: Wallet, other: Wallet
  let tester: PredyMathTester

  before(async () => {
    ;[wallet, other] = await (ethers as any).getSigners()

    const PredyMathTester = await ethers.getContractFactory('PredyMathTester')
    tester = (await PredyMathTester.deploy()) as PredyMathTester
  })

  describe('max', () => {
    it('check max of 1 and 2', async () => {
      const a = scaledBN(1, 6)
      const b = scaledBN(2, 6)
      const max = await tester.testMax(a, b)
      expect(max).to.be.eq(b)
    })

    it('check max of 1 and 1', async () => {
      const a = scaledBN(1, 6)

      const max = await tester.testMax(a, a)

      expect(max).to.be.eq(a)
    })
  })

  describe('min', () => {
    it('check min of 1 and 2', async () => {
      const a = scaledBN(1, 6)
      const b = scaledBN(2, 6)
      const min = await tester.testMin(a, b)
      expect(min).to.be.eq(a)
    })

    it('check min of 1 and 1', async () => {
      const a = scaledBN(1, 6)

      const min = await tester.testMin(a, a)

      expect(min).to.be.eq(a)
    })
  })

  describe('abs', () => {
    it('check abs of -1', async () => {
      const a = BigNumber.from(0).sub(scaledBN(1, 6))
      const expected = scaledBN(1, 6)

      const result = await tester.testAbs(a)

      expect(result).to.be.eq(expected)
    })

    it('check abs of 1', async () => {
      const a = scaledBN(1, 6)
      const expected = scaledBN(1, 6)

      const result = await tester.testAbs(a)

      expect(result).to.be.eq(expected)
    })
  })

  describe('mulDiv', () => {
    it('round down', async () => {
      const x = scaledBN(1, 3)
      const y = scaledBN(1, 3)
      const d = scaledBN(3, 3)

      const result = await tester.testMulDiv(x, y, d, false)

      expect(result).to.be.eq(333)
    })

    it('round up', async () => {
      const x = scaledBN(1, 3)
      const y = scaledBN(1, 3)
      const d = scaledBN(3, 3)

      const result = await tester.testMulDiv(x, y, d, true)

      expect(result).to.be.eq(334)
    })

    it('div large amount and result is less than maxuint128', async () => {
      const x = BigNumber.from(2).pow(128).sub(1)
      const y = 100
      const d = 200

      const result = await tester.testMulDiv(x, y, d, false)

      expect(result).to.be.eq('170141183460469231731687303715884105727')
    })

    it('div large amount and result is greater than maxuint128', async () => {
      const x = BigNumber.from(2).pow(128).sub(1)
      const y = 200
      const d = 100

      await expect(tester.testMulDiv(x, y, d, false)).to.be.revertedWith(
        'SafeCast: value doesn\'t fit in 128 bits',
      )
    })
  })

  describe('scale', () => {
    it('scale small number from decimal 6 to 2', async () => {
      const result = await tester.testScale('12345', 6, 3)

      expect(result).to.be.eq(12)
    })

    it('scale decimal 6 to 2', async () => {
      const result = await tester.testScale('123000000', 6, 2)

      expect(result).to.be.eq(12300)
    })

    it('scale decimal 2 to 6', async () => {
      const result = await tester.testScale('123', 2, 6)

      expect(result).to.be.eq(1230000)
    })

    it('scale decimal 6 to 6', async () => {
      const result = await tester.testScale('12345', 6, 6)

      expect(result).to.be.eq(12345)
    })
  })
})
