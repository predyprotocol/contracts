// SPDX-License-Identifier: agpl-3.0
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../interfaces/IFeePool.sol";

contract MockFeePool is ERC20, IFeePool {
    IERC20 public immutable token;

    constructor(ERC20 _token) ERC20("mock staking", "sMOCK") {
        token = _token;
    }

    function sendProfitERC20(address _account, uint256 _amount) external override {
        require(_amount > 0);
        token.transferFrom(_account, address(this), _amount);
    }
}
