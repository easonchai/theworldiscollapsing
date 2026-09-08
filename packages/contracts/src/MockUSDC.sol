// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IGate} from "./Gate.sol";

/// @notice Testnet play money. 6 decimals like USDC. Faucet gated by Gate, one drip per day.
contract MockUSDC is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    IGate public immutable gate;
    mapping(address => uint256) public lastFaucet;

    error NotVerified();
    error FaucetCooldown();

    constructor(IGate _gate) ERC20("Mock USDC", "USDC") {
        gate = _gate;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        if (!gate.verified(msg.sender)) revert NotVerified();
        if (block.timestamp < lastFaucet[msg.sender] + FAUCET_COOLDOWN) revert FaucetCooldown();
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
