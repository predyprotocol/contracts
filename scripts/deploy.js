const { ethers } = require("hardhat");

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

  let optionURI = ''
  let lpTokenURI = ''

  console.log(network.name)

  if (network.name === 'kovan') {
    // kovan
    aggregatorAddress = '0x9326BFA02ADD2366b30bacB125260Af641031331'
    wethAddress = '0xd0a1e359811322d97991e03f863a0c30c2cf029c'
    usdcAddress = '0xe22da380ee6b445bb8273c81944adeb6e8450422'
    lendingPoolAddress = '0xE0fBa4Fc209b4948668006B2bE61711b7f465bAe'
    botAddress = '0x00980ae805112d6ae97fdbe0d50f916bdecc1e34'

    priceCalculatorAddress = '0x69F93510B7FB7A1BECd520Cd60Aae62065d4a18d'
    priceOracleAddress = '0xEaeF015655a9D6A922AFcc27B3dFEDD1591E7ec9'
    feePoolAddress = '0x7ddf1C3398911fe64459162269ECaB50235e1594'
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

  // deploy price calculator
  if (priceCalculatorAddress === null) {
    const PriceCalculator = await ethers.getContractFactory('PriceCalculator')
    const priceCalculator = await PriceCalculator.deploy()

    priceCalculatorAddress = priceCalculator.address
  }

  console.log("PriceCalculator: ", priceCalculatorAddress);

  // deploy option vault library
  const OptionLib = await ethers.getContractFactory('OptionLib', {
    libraries: {
      PriceCalculator: priceCalculatorAddress,
    },
  })
  const optionLib = await OptionLib.deploy()

  console.log("OptionLib: ", optionLib.address);

  // deploy option AMM library
  const AMMLib = await ethers.getContractFactory('AMMLib', {
    libraries: {
      PriceCalculator: priceCalculatorAddress,
    },
  })
  const ammLib = await AMMLib.deploy()

  console.log("AMMLib: ", ammLib.address);

  // deploy fee pool
  if (feePoolAddress === null) {
    const FeePool = await ethers.getContractFactory('FeePool')
    const feePool = await FeePool.deploy(usdcAddress)

    feePoolAddress = feePool.address
  }

  console.log("FeePool: ", feePoolAddress);

  // deploy price oracle
  if (priceOracleAddress == null) {
    const PriceOracle = await ethers.getContractFactory('PriceOracle')
    const priceOracle = await PriceOracle.deploy()
    await priceOracle.setAggregator(aggregatorAddress)

    priceOracleAddress = priceOracleAddress
  }

  console.log("PriceOracle: ", priceOracleAddress);

  // deploy option vault factory
  const OptionVaultFactory = await ethers.getContractFactory('OptionVaultFactory', {
    libraries: {
      OptionLib: optionLib.address,
    },
  })

  // deploy AMM factory
  const AMMFactory = await ethers.getContractFactory('AMMFactory', {
    libraries: {
      AMMLib: ammLib.address,
    },
  })

  const AMM = await ethers.getContractFactory('AMM', {
    libraries: {
      AMMLib: ammLib.address,
    },
  })

  const optionVaultFactory = await OptionVaultFactory.deploy(
    usdcAddress,
    priceOracle.address,
    { gasLimit: 6000000 }
  )

  const ammFactory = await AMMFactory.deploy(
    usdcAddress,
    operatorAddress,
    feePoolAddress,
    priceOracleAddress,
    optionVaultFactory.address,
    { gasLimit: 6000000 }
  )

  await optionVaultFactory.setAMMFactoryAddress(ammFactory.address)

  console.log("OptionVaultFactory: ", optionVaultFactory.address);
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

  await amm.setBot(botAddress, { gasLimit: 300000 });

  console.log("ETH vault: ", ethPool.optionsVaultAddress);
  console.log("ETH AMM: ", ethPool.ammAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
