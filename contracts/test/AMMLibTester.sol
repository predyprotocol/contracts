// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "../lib/AMMLib.sol";

contract AMMLibTester {
    AMMLib.PoolInfo public pool;
    mapping(uint256 => AMMLib.LockedOptionStatePerTick[]) private locks;

    constructor() {}

    function ticks(uint32 _index) external view returns (AMMLib.Tick memory) {
        return pool.ticks[_index];
    }

    function clear() external {
        delete pool;
        delete locks[1];
    }

    function testAddProfit(uint32 _tickId, uint128 _profit) external {
        pool.ticks[_tickId].balance += _profit;
    }

    function testAddLoss(uint32 _tickId, uint128 _loss) external {
        pool.ticks[_tickId].balance -= _loss;
    }

    function makeSnapshot(uint32 _tickId) external {
        pool.ticks[_tickId].lastBalance = pool.ticks[_tickId].balance;
        pool.ticks[_tickId].lastSupply = pool.ticks[_tickId].supply;
    }

    function addBalance(
        uint32 _tickStart,
        uint32 _tickEnd,
        uint128 _mint
    ) external returns (uint128) {
        return AMMLib.addBalance(pool, _tickStart, _tickEnd, _mint);
    }

    function removeBalance(
        uint32 _tickStart,
        uint32 _tickEnd,
        uint128 _burn
    ) external returns (uint128) {
        return AMMLib.removeBalance(pool, _tickStart, _tickEnd, _burn);
    }

    function getMintAmount(
        uint32 _tickStart,
        uint32 _tickEnd,
        uint128 _amount
    ) external view returns (uint128) {
        return AMMLib.getMintAmount(pool, _tickStart, _tickEnd, _amount);
    }

    function getWithdrawableAmount(
        uint32 _tickStart,
        uint32 _tickEnd,
        uint128 _burn
    ) external view returns (uint128 withdrawableAmount) {
        return AMMLib.getWithdrawableAmount(pool, _tickStart, _tickEnd, _burn);
    }
}
