// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface IGate {
    function verified(address account) external view returns (bool);
}

/// @notice Per-address verified flag. Set by the operator after World Selfie Check
///         (or the self-attest fallback). Read by MockUSDC.faucet and Arena.bet.
contract Gate is Ownable, IGate {
    mapping(address => bool) public verified;

    event Verified(address indexed account, bool verified);

    constructor(address owner) Ownable(owner) {}

    function setVerified(address account, bool ok) external onlyOwner {
        verified[account] = ok;
        emit Verified(account, ok);
    }
}
