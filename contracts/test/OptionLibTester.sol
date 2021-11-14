// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "../lib/OptionLib.sol";

contract OptionLibTester {
    using OptionLib for OptionLib.OptionInfo;

    OptionLib.OptionInfo optionInfo;
    IOptionVault.Vault vault;

    function testInit(
        address _collateral,
        address _underlying,
        address _lendingPool
    ) external {
        optionInfo.init(_collateral, _underlying, _lendingPool);
    }

    function testUpdateShort(
        uint128 _expiryId,
        uint256 _seriesId,
        uint128 _size
    ) external {
        optionInfo.accounts[0].vaults[_expiryId].shorts[_seriesId] = _size;
    }

    function testUpdateLong(
        uint128 _expiryId,
        uint256 _seriesId,
        uint128 _size
    ) external {
        optionInfo.accounts[0].vaults[_expiryId].longs[_seriesId] = _size;
    }

    function testUpdateExpiration(
        uint128 _expiryId,
        uint64 _expiry,
        uint256[] memory _seriesIds
    ) external {
        optionInfo.expiries[_expiryId] = IOptionVault.Expiration(_expiryId, _expiry, _seriesIds);
    }

    function testUpdateSeries(
        uint256 _seriesId,
        uint64 strike,
        bool isPut,
        uint64 iv,
        uint128 expiryId
    ) external {
        optionInfo.serieses[_seriesId] = IOptionVault.OptionSeries(strike, isPut, iv, expiryId);
    }

    function testGetRequiredCollateral(
        uint256 _accountId,
        uint256 _expiryId,
        uint128 _spot,
        IOptionVault.MarginLevel _marginLevel
    ) public view returns (uint128) {
        return optionInfo.getRequiredMargin(_accountId, _expiryId, _spot, _marginLevel);
    }

    function testRedeemCollateralFromLendingPool(
        uint128 _repayAmount,
        uint128 _price,
        address _caller,
        address _feePool
    ) external {
        return optionInfo.redeemCollateralFromLendingPool(_repayAmount, _price, _caller, _feePool);
    }
}
