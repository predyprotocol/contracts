import { ethers } from 'hardhat'
import { expect } from 'chai'
import { PriceCalculator, PriceCalculatorTester } from '../typechain'
import { scaledBN } from './utils/helpers'
import { BigNumber } from '@ethersproject/bignumber'

describe('PriceCalculator', () => {
  let tester: PriceCalculatorTester

  before(async () => {
    const PriceCalculator = await ethers.getContractFactory('PriceCalculator')
    const priceCalculator = (await PriceCalculator.deploy()) as PriceCalculator

    const PriceCalculatorTester = await ethers.getContractFactory('PriceCalculatorTester', {
      libraries: {
        PriceCalculator: priceCalculator.address,
      },
    })

    tester = (await PriceCalculatorTester.deploy()) as PriceCalculatorTester
  })

  describe('calculatePrice', () => {
    // $2200
    const spot = scaledBN(2200, 8)
    const maturity = 60 * 60 * 24 * 7

    it('reverts if IV is 0', async () => {
      // $2200
      const strike = scaledBN(2200, 8)
      const iv = 0

      await expect(tester.calculatePrice(spot, strike, maturity, iv, false)).to.be.revertedWith(
        'PriceCalculator: implied volatility must be between 0 and 1000%',
      )
    })

    it('reverts if maturity is 0', async () => {
      // $2200
      const strike = scaledBN(2200, 8)
      const maturity = 0
      const iv = scaledBN(50, 6)

      await expect(tester.calculatePrice(spot, strike, maturity, iv, false)).to.be.revertedWith(
        'PriceCalculator: maturity must not have expired and less than 1 year',
      )
    })

    describe('option price IV 50%', () => {
      // 50%
      const iv = scaledBN(50, 6)
      it('calculate ATM call option price', async () => {
        // $2200
        const strike = scaledBN(2200, 8)
        const premium = await tester.calculatePrice(spot, strike, maturity, iv, false)

        // asserts
        expect(premium.toString()).to.be.eq('6063545400')
      })

      it('calculate OTM call option price', async () => {
        // $2400
        const strike = scaledBN(2400, 8)
        const premium = await tester.calculatePrice(spot, strike, maturity, iv, false)

        // asserts
        expect(premium.toString()).to.be.eq('787553600')
      })

      it('calculate ITM call option price', async () => {
        // $2000
        const strike = scaledBN(2000, 8)
        const premium = await tester.calculatePrice(spot, strike, maturity, iv, false)

        // asserts
        expect(premium.toString()).to.be.eq('20554678600')
      })

      it('calculate ATM put option price', async () => {
        // $2200
        const strike = scaledBN(2200, 8)
        const premium = await tester.calculatePrice(spot, strike, maturity, iv, true)

        // asserts
        expect(premium.toString()).to.be.eq('6063545400')
      })

      it('calculate OTM put option price', async () => {
        // $2000
        const strike = scaledBN(2000, 8)
        const premium = await tester.calculatePrice(spot, strike, maturity, iv, true)

        // asserts
        expect(premium.toString()).to.be.eq('554678600')
      })

      it('calculate ITM put option price', async () => {
        // $2400
        const strike = scaledBN(2400, 8)
        const premium = await tester.calculatePrice(spot, strike, maturity, iv, true)

        // asserts
        expect(premium.toString()).to.be.eq('20787553600')
      })
    })
  })

  describe('calculatePrice2', () => {
    // $2200
    const spot = scaledBN(2200, 8)
    const maturity = 60 * 60 * 24 * 7
    const minDelta = 0

    it('reverts if IV is 0', async () => {
      // $2200
      const strike = scaledBN(2200, 8)
      const x0 = 0
      const x1 = 100
      await expect(tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)).to.be.revertedWith(
        '0 < x0 < 1000%',
      )
    })

    it('reverts if maturity is 0', async () => {
      // $2200
      const strike = scaledBN(2200, 8)
      const maturity = 0
      const x0 = scaledBN(50, 6)
      const x1 = scaledBN(51, 6)
      await expect(tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)).to.be.revertedWith(
        'PriceCalculator: maturity must not have expired and less than 1 year',
      )
    })

    it('calculating call option price reverts if delta is too low', async () => {
      // $2200
      const strike = scaledBN(2400, 8)
      const x0 = scaledBN(50, 6)
      const x1 = scaledBN(51, 6)
      // min delta is 50%
      const minDelta = scaledBN(50, 6)

      await expect(tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)).to.be.revertedWith(
        'delta is too low',
      )
    })

    it('calculating put option price reverts if delta is too low', async () => {
      // $2200
      const strike = scaledBN(2000, 8)
      const x0 = scaledBN(50, 6)
      const x1 = scaledBN(51, 6)
      // min delta is 50%
      const minDelta = scaledBN(50, 6)

      await expect(tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)).to.be.revertedWith(
        'delta is too low',
      )
    })

    describe('option price IV 2%', () => {
      it('ITM', async () => {
        // 2%-2.1%
        const x0 = scaledBN(20, 5)
        const x1 = scaledBN(21, 5)
        // $600
        const spot = scaledBN(600, 8)
        // $300
        const strike = scaledBN(300, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium).to.be.eq('30000000000')
      })

      it('OTM', async () => {
        // 2%-2.1%
        const x0 = scaledBN(20, 5)
        const x1 = scaledBN(21, 5)
        // $300
        const spot = scaledBN(300, 8)
        // $600
        const strike = scaledBN(600, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium).to.be.eq(0)
      })
    })

    describe('option price IV 50%', () => {
      // 50%
      const x0 = scaledBN(50, 6)
      const x1 = scaledBN(51, 6)
      it('calculate ATM call option price', async () => {
        // $2200
        const strike = scaledBN(2200, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('6128526800')
      })

      it('calculate OTM call option price', async () => {
        // $2400
        const strike = scaledBN(2400, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('909061640')
      })

      it('calculate ITM call option price', async () => {
        // $2000
        const strike = scaledBN(2000, 8)
        const minDelta = scaledBN(10, 6)

        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('20663097655')
      })

      it('calculate ATM put option price', async () => {
        // $2200
        const strike = scaledBN(2200, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('6128526800')
      })

      it('calculate OTM put option price', async () => {
        // $2000
        const strike = scaledBN(2000, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('663097655')
      })

      it('calculate ITM put option price', async () => {
        // $2400
        const strike = scaledBN(2400, 8)
        const minDelta = scaledBN(10, 6)

        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('20909061640')
      })
    })

    describe('option price IV 100%', () => {
      // 100%
      const x0 = scaledBN(100, 6)
      const x1 = scaledBN(101, 6)

      it('calculate ATM call option price', async () => {
        // $2200
        const strike = scaledBN(2200, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('12189185250')
      })

      it('calculate OTM call option price', async () => {
        // $2400
        const strike = scaledBN(2400, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('5157672820')
      })

      it('calculate call option price with high strike price', async () => {
        // $5000
        const strike = scaledBN(5000, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium).to.be.eq(1560)
      })

      it('calculate ITM call option price', async () => {
        // $2000
        const strike = scaledBN(2000, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('24261954880')
      })

      it('calculate ATM put option price', async () => {
        // $2200
        const strike = scaledBN(2200, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('12189185250')
      })

      it('calculate OTM put option price', async () => {
        // $2000
        const strike = scaledBN(2000, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('4261954880')
      })

      it('calculate call option price with low strike price', async () => {
        // $1000
        const strike = scaledBN(1000, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium).to.be.eq(0)
      })

      it('calculate ITM put option price', async () => {
        // $2400
        const strike = scaledBN(2400, 8)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('25157672820')
      })
    })

    describe('call edge cases', () => {
      it('one range', async () => {
        const strike = scaledBN(2200, 8)
        const x0 = scaledBN(60, 6)
        const x1 = scaledBN(80, 6)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('9097268400')
      })

      it('two range', async () => {
        const strike = scaledBN(2200, 8)
        const x0 = scaledBN(70, 6)
        const x1 = scaledBN(90, 6)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('9703013100')
      })

      it('small diff', async () => {
        const strike = scaledBN(2200, 8)
        const x0 = '121000000'
        const x1 = '121000001'
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, false, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('14673762570')
      })
    })

    describe('put edge cases', () => {
      it('one range', async () => {
        const strike = scaledBN(2200, 8)
        const x0 = scaledBN(60, 6)
        const x1 = scaledBN(80, 6)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('9097268400')
      })

      it('two range', async () => {
        const strike = scaledBN(2200, 8)
        const x0 = scaledBN(70, 6)
        const x1 = scaledBN(90, 6)
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('9703013100')
      })

      it('small diff', async () => {
        const strike = scaledBN(2200, 8)
        const x0 = '121000000'
        const x1 = '121000001'
        const premium = await tester.calculatePrice2(spot, strike, maturity, x0, x1, true, minDelta)

        // asserts
        expect(premium.toString()).to.be.eq('14673762570')
      })
    })
  })

  describe('calculateDelta', () => {
    const maturity = 60 * 60 * 24 * 7
    let sqrtMaturity: BigNumber

    before(async () => {
      sqrtMaturity = await tester.getSqrtMaturity(maturity)
    })

    describe('call', () => {
      it('ITM', async () => {
        // 70%
        const iv = scaledBN(70, 6)
        // $600
        const spot = scaledBN(600, 8)
        // $500
        const strike = scaledBN(500, 8)

        const delta = await tester.calculateDelta(spot, strike, sqrtMaturity, iv, false)

        // asserts
        expect(delta.toString()).to.be.eq('97411257')
      })

      it('OTM', async () => {
        // 70%
        const iv = scaledBN(70, 6)
        // $500
        const spot = scaledBN(500, 8)
        // $600
        const strike = scaledBN(600, 8)
        const delta = await tester.calculateDelta(spot, strike, sqrtMaturity, iv, false)

        // asserts
        expect(delta.toString()).to.be.eq('3349801')
      })
    })

    describe('put', () => {
      it('ITM', async () => {
        // 70%
        const iv = scaledBN(70, 6)
        // $500
        const spot = scaledBN(500, 8)
        // $600
        const strike = scaledBN(600, 8)
        const delta = await tester.calculateDelta(spot, strike, sqrtMaturity, iv, true)

        // asserts
        expect(delta.toString()).to.be.eq('-96650199')
      })

      it('OTM', async () => {
        // 70%
        const iv = scaledBN(70, 6)
        // $600
        const spot = scaledBN(600, 8)
        // $500
        const strike = scaledBN(500, 8)
        const delta = await tester.calculateDelta(spot, strike, sqrtMaturity, iv, true)

        // asserts
        expect(delta.toString()).to.be.eq('-2588743')
      })
    })
  })
})
