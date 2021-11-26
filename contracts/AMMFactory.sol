// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "./AMM.sol";
import "./OptionVaultFactory.sol";

contract AMMFactory {
    struct Pair {
        AMM amm;
        OptionVault optionVault;
    }

    /// @dev ammId => AMM
    mapping(uint256 => Pair) public pairs;

    /// @dev amm id counter
    uint256 pairCounter;

    ///@dev collateral address
    address public immutable collateral;

    ///@dev operator address
    address public immutable operator;

    ///@dev fee recipient
    address public immutable feeRecipient;

    ///@dev price oracle
    address public immutable priceOracle;

    /// @dev option contract factory
    OptionVaultFactory immutable optionVaultFactory;

    event PairCreated(uint256 ammId, address ammAddress, address optionVaultAddress, address aggregator);

    /**
     * @param _collateral collateral address
     * @param _operator operator address
     * @param _feeRecipient fee recipient
     * @param _priceOracle price oracle
     */
    constructor(
        address _collateral,
        address _operator,
        address _feeRecipient,
        address _priceOracle,
        address _optionVaultFactoryAddress
    ) {
        collateral = _collateral;
        operator = _operator;
        feeRecipient = _feeRecipient;
        priceOracle = _priceOracle;
        optionVaultFactory = OptionVaultFactory(_optionVaultFactoryAddress);
    }

    /**
     * @notice create new vault and amm
     * @param _aggregator chainlink aggregator address
     * @param _underlying underlying address
     * @param _lendingPool lending pool contract address
     */
    function createVaultAndAMM(
        string memory _uri,
        string memory _lpTokenUri,
        address _aggregator,
        address _underlying,
        address _lendingPool
    ) external {
        uint256 pairId = pairCounter;

        OptionVault optionVault = optionVaultFactory.create(_uri, operator, _aggregator, _underlying, _lendingPool);

        AMM amm = createAMM(_lpTokenUri, _aggregator, address(optionVault));

        optionVault.setAMMAddress(address(amm));

        pairs[pairId] = Pair(amm, optionVault);

        pairCounter += 1;

        // emit event
        emit PairCreated(pairId, address(amm), address(optionVault), _aggregator);
    }

    /**
     * @notice create new amm pool
     * @param _aggregator chainlink aggregator address
     */
    function createAMM(
        string memory _uri,
        address _aggregator,
        address _optionContract
    ) internal returns (AMM) {
        // validate inputs
        require(_aggregator != address(0), "AMMFactory: aggregator asset address must not be 0");

        AMM amm = new AMM(_uri, _aggregator, collateral, priceOracle, feeRecipient, operator, _optionContract);

        return amm;
    }
}
