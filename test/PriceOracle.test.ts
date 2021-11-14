import { ethers } from 'hardhat'
import { expect } from 'chai'
import { MockChainlinkAggregator } from '../typechain/MockChainlinkAggregator'
import { PriceOracle } from '../typechain/PriceOracle'
import { getExpiry, increaseTime, scaledBN, setTime } from './utils/helpers'
import { DISPUTE_PERIOD } from './constants'

describe('PriceOracle', function () {
  let aggregator: MockChainlinkAggregator
  let priceOracle: PriceOracle
  let expiry14: number

  before(async () => {
    const MockChainlinkAggregator = await ethers.getContractFactory('MockChainlinkAggregator')
    aggregator = (await MockChainlinkAggregator.deploy()) as MockChainlinkAggregator

    const PriceOracle = await ethers.getContractFactory('PriceOracle')
    priceOracle = (await PriceOracle.deploy()) as PriceOracle

    await priceOracle.setAggregator(aggregator.address)
  })

  beforeEach(async () => {
    expiry14 = await getExpiry(14)
  })

  describe('setExpiryPrice', () => {
    const roundId = 100
    const spot = scaledBN(1200, 8)

    it('set correctly', async () => {
      await setTime(expiry14 + 60)

      await aggregator.setLatestRoundData(roundId, spot)

      await priceOracle.setExpiryPrice(aggregator.address, expiry14)

      const beforeResult = await priceOracle.getExpiryPrice(aggregator.address, expiry14)

      expect(beforeResult._isFinalized).to.be.false

      await increaseTime(DISPUTE_PERIOD)

      const result = await priceOracle.getExpiryPrice(aggregator.address, expiry14)

      expect(result._isFinalized).to.be.true
      expect(result.price).to.be.eq(spot)
    })

    it('reverts if timestamp is earlier than expiry', async () => {
      await aggregator.setLatestRoundData(roundId, spot)

      await expect(priceOracle.setExpiryPrice(aggregator.address, expiry14)).to.be.revertedWith(
        'PriceOracle: price timestamp must be later than expiry',
      )
    })

    it('reverts if price has been setted', async () => {
      await setTime(expiry14 + 60)

      await aggregator.setLatestRoundData(roundId, spot)

      await priceOracle.setExpiryPrice(aggregator.address, expiry14)

      await expect(priceOracle.setExpiryPrice(aggregator.address, expiry14)).to.be.revertedWith(
        'PriceOracle: already setted',
      )
    })

    it('set after dispute period', async () => {
      await setTime(expiry14 + 60)

      await aggregator.setLatestRoundData(roundId, spot)

      await increaseTime(DISPUTE_PERIOD)

      await priceOracle.setExpiryPrice(aggregator.address, expiry14)

      const result = await priceOracle.getExpiryPrice(aggregator.address, expiry14)

      expect(result._isFinalized).to.be.true
      expect(result.price).to.be.eq(spot)
    })
  })

  describe('updateExpiryPrice', () => {
    const roundId1 = 100
    const roundId2 = 110
    const spot1 = scaledBN(1200, 8)
    const spot2 = scaledBN(1500, 8)

    it('update correctly', async () => {
      await setTime(expiry14 + 30)

      await aggregator.setLatestRoundData(roundId1, spot1)

      await increaseTime(30)

      await aggregator.setLatestRoundData(roundId2, spot2)

      await priceOracle.setExpiryPrice(aggregator.address, expiry14)

      await priceOracle.updateExpiryPrice(aggregator.address, expiry14, roundId1)

      const beforeResult = await priceOracle.getExpiryPrice(aggregator.address, expiry14)

      expect(beforeResult._isFinalized).to.be.false

      await increaseTime(DISPUTE_PERIOD)

      const result = await priceOracle.getExpiryPrice(aggregator.address, expiry14)

      expect(result._isFinalized).to.be.true
      expect(result.price).to.be.eq(spot1)
    })

    it("reverts if updated price's timestamp is later than previous one", async () => {
      await setTime(expiry14 + 30)

      await aggregator.setLatestRoundData(roundId1, spot1)

      await increaseTime(30)

      await priceOracle.setExpiryPrice(aggregator.address, expiry14)

      await aggregator.setLatestRoundData(roundId2, spot2)

      await expect(priceOracle.updateExpiryPrice(aggregator.address, expiry14, roundId1)).to.be.revertedWith(
        "PriceOracle: new price's timestamp must be close to expiry",
      )
    })

    it('reverts if timestamp is earlier than expiry', async () => {
      await expect(priceOracle.updateExpiryPrice(aggregator.address, expiry14, roundId1)).to.be.revertedWith(
        'PriceOracle: price timestamp must be later than expiry',
      )
    })
  })
})
