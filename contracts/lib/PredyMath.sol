// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

library PredyMath {
    function max(uint128 a, uint128 b) internal pure returns (uint128) {
        return a > b ? a : b;
    }

    function min(uint128 a, uint128 b) internal pure returns (uint128) {
        return a > b ? b : a;
    }

    function abs(int128 x) internal pure returns (uint128) {
        return uint128(x >= 0 ? x : -x);
    }

    function div64(
        uint64 _x,
        uint64 _d,
        bool _roundUp
    ) internal pure returns (uint64) {
        uint64 tailing;
        if (_roundUp) {
            uint64 remainer = _x % _d;
            if (remainer > 0) {
                tailing = 1;
            }
        }
        return _x / _d + tailing;
    }

    function mulDiv(
        uint128 _x,
        uint128 _y,
        uint128 _d,
        bool _roundUp
    ) internal pure returns (uint128) {
        uint128 tailing;
        if (_roundUp) {
            uint128 remainer = (_x * _y) % _d;
            if (remainer > 0) {
                tailing = 1;
            }
        }
        return (_x * _y) / _d + tailing;
    }

    function scale(
        uint256 _a,
        uint256 _from,
        uint256 _to
    ) internal pure returns (uint256) {
        if (_from > _to) {
            return _a / 10**(_from - _to);
        } else if (_from < _to) {
            return _a * 10**(_to - _from);
        } else {
            return _a;
        }
    }
}
