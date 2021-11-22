const { ethers } = require("hardhat");

const BASE_SPREAD = 4
const SPREAD_OF_SWAP = 5

async function main() {
  const signer = await ethers.getSigner()
  const network = await signer.provider.getNetwork()

  console.log('deployer: ', signer.address)

  let aggregatorAddress
  let wethAddress
  let usdcAddress
  let lendingPoolAddress
  let botAddress
  let priceOracleAddress = null
  let priceCalculatorAddress = null
  let feePoolAddress = null
  let ammLibAddress = null
  let optionLibAddress = null

  let optionURI = ''
  let lpTokenURI = ''

  console.log(network.name)

  if (network.name === 'kovan') {
    // kovan
    aggregatorAddress = '0x9326BFA02ADD2366b30bacB125260Af641031331'
    wethAddress = '0xd0a1e359811322d97991e03f863a0c30c2cf029c'

    // replace to link address
    aggregatorAddress = '0x396c5E36DD0a0F5a5D33dae44368D4193f69a1F0'
    wethAddress = '0xAD5ce863aE3E4E9394Ab43d4ba0D80f419F61789'

    usdcAddress = '0xe22da380ee6b445bb8273c81944adeb6e8450422'
    lendingPoolAddress = '0xE0fBa4Fc209b4948668006B2bE61711b7f465bAe'
    botAddress = '0x00980ae805112d6ae97fdbe0d50f916bdecc1e34'

    priceCalculatorAddress = '0xbA21E414a411006ffD537DB37833F4591ae6A52c'
    priceOracleAddress = '0x6c272999e488af31991e7c9F875f4E93b72901fc'
    feePoolAddress = '0x7ddf1C3398911fe64459162269ECaB50235e1594'
    ammLibAddress = '0xEde7eB69cdc8c8d1840cEA2e296ea52485588882'
    optionLibAddress = '0xde3b7a4C30aA6443CAD98763340594b7411dE0c6'
  } else if (network.name === 'rinkeby') {
    // rinkeby
    aggregatorAddress = '0x8A753747A1Fa494EC906cE90E9f37563A8AF630e'
    wethAddress = '0xc778417e063141139fce010982780140aa0cd5ab'
    usdcAddress = '0x4DBCdF9B62e891a7cec5A2568C3F4FAF9E8Abe2b'
    lendingPoolAddress = '0x2eaa9d77ae4d8f9cdd9faacd44016e746485bddb'
    botAddress = '0x00980ae805112d6ae97fdbe0d50f916bdecc1e34'
  } else if (network.name === 'mainnet') {
    aggregatorAddress = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
    wethAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
    usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
    lendingPoolAddress = '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9'
    botAddress = '0x476bc58e57316242fad6cd86c9caa3c3a2a93594'

  } else if (network.name === 'polygon') {
    aggregatorAddress = '0xf9680d99d6c9589e2a93a78a04a279e509205945'
    wethAddress = '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619'
    usdcAddress = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
    lendingPoolAddress = '0x8dff5e27ea6b7ac08ebfdf9eb090f32ee9a30fcf'
    botAddress = '0x6631b184eec40330e2a484dd48135271a675a09d'

  } else if (network.name === 'maticmum') {
    aggregatorAddress = '0x0715A7794a1dc8e42615F059dD6e406A6594651A'
    wethAddress = '0x3c68ce8504087f89c640d02d133646d98e64ddd9'
    usdcAddress = '0x2058a9d7613eee744279e3856ef0eada5fcbaa7e'
    lendingPoolAddress = '0x9198F13B08E299d85E096929fA9781A1E3d5d827'
    botAddress = '0x76ffced5850d58287151ba814422d338b5e9db13'

    priceCalculatorAddress = '0x5935Ae358ce6F78D64a3c7493fd4C3F495175cAb'
    priceOracleAddress = '0xE3f8E1543E41cAc1C6aAecCf030e1C5538b508DA'
    feePoolAddress = '0x3EBd54Da5Eae31b95770ef0E191DBa51fcED3411'
  } else {
    throw new Error('unknown network')
  }

  console.log("chainlink aggregator: ", aggregatorAddress);
  console.log("USDC: ", usdcAddress);

  const operatorAddress = '0x1c745d31A084a14Ba30E7c9F4B14EA762d44f194'
  const newOperatorAddress = '0xb8d843c8E6e0E90eD2eDe80550856b64da92ee30'

  // deploy price calculator
  if (priceCalculatorAddress === null) {
    const PriceCalculator = await ethers.getContractFactory('PriceCalculator')
    const priceCalculator = await PriceCalculator.deploy()

    await priceCalculator.deployTransaction.wait()

    priceCalculatorAddress = priceCalculator.address
  }

  console.log("PriceCalculator: ", priceCalculatorAddress);

  // deploy option vault library
  if (optionLibAddress === null) {
    const OptionLib = await ethers.getContractFactory('OptionLib', {
      libraries: {
        PriceCalculator: priceCalculatorAddress,
      },
    })
    const optionLib = await OptionLib.deploy()

    await optionLib.deployTransaction.wait()

    optionLibAddress = optionLib.address
  }

  console.log("OptionLib: ", optionLibAddress);

  // deploy option AMM library
  if (ammLibAddress === null) {
    const AMMLib = await ethers.getContractFactory('AMMLib', {
      libraries: {
        PriceCalculator: priceCalculatorAddress,
      },
    })
    const ammLib = await AMMLib.deploy()

    await ammLib.deployTransaction.wait()

    ammLibAddress = ammLib.address
  }

  console.log("AMMLib: ", ammLibAddress);

  // deploy fee pool
  if (feePoolAddress === null) {
    const FeePool = await ethers.getContractFactory('FeePool')
    const feePool = await FeePool.deploy(usdcAddress)

    await feePool.deployTransaction.wait()

    feePoolAddress = feePool.address
  }

  console.log("FeePool: ", feePoolAddress);

  // deploy price oracle
  if (priceOracleAddress == null) {
    const PriceOracle = await ethers.getContractFactory('PriceOracle')
    const priceOracle = await PriceOracle.deploy()

    await priceOracle.deployTransaction.wait()

    const tx = await priceOracle.setAggregator(aggregatorAddress)

    await tx.wait()

    priceOracleAddress = priceOracleAddress
  }

  console.log("PriceOracle: ", priceOracleAddress);

  // deploy option vault factory
  const OptionVaultFactory = await ethers.getContractFactory('OptionVaultFactory', {
    libraries: {
      OptionLib: optionLibAddress,
    },
  })

  // deploy AMM factory
  const AMMFactory = await ethers.getContractFactory('AMMFactory', {
    libraries: {
      AMMLib: ammLibAddress,
    },
  })

  const AMM = await ethers.getContractFactory('AMM', {
    libraries: {
      AMMLib: ammLibAddress,
    },
  })

  const optionVaultFactory = await OptionVaultFactory.deploy(
    usdcAddress,
    priceOracleAddress,
    { gasLimit: 6000000 }
  )

  await optionVaultFactory.deployTransaction.wait()

  console.log("OptionVaultFactory: ", optionVaultFactory.address);

  const ammFactory = await AMMFactory.deploy(
    usdcAddress,
    operatorAddress,
    feePoolAddress,
    priceOracleAddress,
    optionVaultFactory.address,
    { gasLimit: 6000000 }
  )

  await ammFactory.deployTransaction.wait()

  const setAMMFactoryAddressTx = await optionVaultFactory.setAMMFactoryAddress(ammFactory.address)

  await setAMMFactoryAddressTx.wait()

  console.log("AMMFactory: ", ammFactory.address);

  async function createPool(aggregator) {
    const tx = await ammFactory.createVaultAndAMM(optionURI, lpTokenURI, aggregator, wethAddress, lendingPoolAddress)
    const receipt = await tx.wait()
    const ammArgs = receipt.events?.filter((x) => x.event === 'PairCreated')[0].args

    return {
      pairId: ammArgs.pairId,
      optionsVaultAddress: ammArgs.optionVaultAddress,
      ammAddress: ammArgs.ammAddress
    }
  }

  const ethPool = await createPool(aggregatorAddress)

  const amm = await AMM.attach(ethPool.ammAddress)

  const setBotTx = await amm.setBot(botAddress, { gasLimit: 300000 });
  await setBotTx.wait()

  await amm.setNewOperator(newOperatorAddress);

  console.log("ETH vault: ", ethPool.optionsVaultAddress);
  console.log("ETH AMM: ", ethPool.ammAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
