// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./OptionVault.sol";

contract OptionVaultFactory is Ownable {
    ///@dev collateral address
    address immutable collateral;

    ///@dev price oracle
    address immutable priceOracle;

    address ammFactoryAddress;

    modifier onlyAMMFactory() {
        require(msg.sender == ammFactoryAddress);
        _;
    }

    /**
     * @param _collateral collateral address
     * @param _priceOracle price oracle
     */
    constructor(address _collateral, address _priceOracle) {
        collateral = _collateral;
        priceOracle = _priceOracle;
    }

    function setAMMFactoryAddress(address _ammFactoryAddress) external onlyOwner {
        ammFactoryAddress = _ammFactoryAddress;
    }

    /**
     * @notice create new pool
     * @param _operator operator address
     * @param _aggregator chainlink aggregator address
     */
    function create(
        string memory _uri,
        address _operator,
        address _aggregator,
        address _underlying,
        address _lendingPool
    ) external onlyAMMFactory returns (OptionVault) {
        // validate inputs
        require(_aggregator != address(0), "aggregator != 0");

        OptionVault optionVault = new OptionVault(
            _uri,
            _aggregator,
            collateral,
            _underlying,
            priceOracle,
            _operator,
            _lendingPool
        );

        return optionVault;
    }
}
