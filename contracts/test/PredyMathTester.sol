// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "../lib/PredyMath.sol";

contract PredyMathTester {
    function testMax(uint128 a, uint128 b) external pure returns (uint128) {
        return PredyMath.max(a, b);
    }

    function testMin(uint128 a, uint128 b) external pure returns (uint128) {
        return PredyMath.min(a, b);
    }

    function testAbs(int128 x) external pure returns (uint128) {
        return PredyMath.abs(x);
    }

    function testMulDiv(
        uint256 _x,
        uint256 _y,
        uint256 _d,
        bool _roundUp
    ) external pure returns (uint128) {
        return PredyMath.mulDiv(_x, _y, _d, _roundUp);
    }

    function testScale(
        uint256 _a,
        uint256 _from,
        uint256 _to
    ) external pure returns (uint256) {
        return PredyMath.scale(_a, _from, _to);
    }
}
