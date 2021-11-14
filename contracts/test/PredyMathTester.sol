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

    function testDiv64(
        uint64 _x,
        uint64 _d,
        bool _roundUp
    ) external pure returns (uint64) {
        return PredyMath.div64(_x, _d, _roundUp);
    }

    function testMulDiv(
        uint128 _x,
        uint128 _y,
        uint128 _d,
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
