// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "../lib/AdvancedMath.sol";
import "../lib/PriceCalculator.sol";

contract PriceCalculatorTester {
    uint256 premium;
    int256 delta;

    constructor() {}

    function calculatePrice(
        uint256 _spot,
        uint256 _strike,
        uint256 _maturity,
        uint256 _iv,
        bool _isPut
    ) external pure returns (uint256) {
        return PriceCalculator.calculatePrice(_spot, _strike, _maturity, _iv, _isPut);
    }

    function calculatePrice2(
        uint256 _spot,
        uint256 _strike,
        uint256 _maturity,
        uint256 _x0,
        uint256 _x1,
        bool _isPut
    ) external pure returns (uint256) {
        return PriceCalculator.calculatePrice2(_spot, _strike, _maturity, _x0, _x1, _isPut);
    }

    function calculateDelta(
        uint256 _spot,
        uint256 _strike,
        int256 _maturity,
        uint256 _iv,
        bool _isPut
    ) external pure returns (int256) {
        return PriceCalculator.calculateDelta(_spot, _strike, _maturity, _iv, _isPut);
    }

    function getSqrtMaturity(uint256 _maturity) external pure returns (int256) {
        return PriceCalculator.getSqrtMaturity(_maturity);
    }
}
