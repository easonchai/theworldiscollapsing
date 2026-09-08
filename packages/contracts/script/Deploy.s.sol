// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Gate} from "../src/Gate.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {Arena} from "../src/Arena.sol";
import {DrandVerifier} from "../src/DrandVerifier.sol";

contract Deploy is Script {
    function run() external {
        address resolver = vm.envAddress("RESOLVER");
        address treasury = vm.envAddress("TREASURY");
        vm.startBroadcast();
        Gate gate = new Gate(msg.sender);
        MockUSDC usdc = new MockUSDC(gate);
        Arena arena = new Arena(usdc, gate, resolver, treasury);
        DrandVerifier verifier = new DrandVerifier();
        arena.setVerifier(verifier);
        vm.stopBroadcast();
        console.log("GATE=%s", address(gate));
        console.log("USDC=%s", address(usdc));
        console.log("ARENA=%s", address(arena));
        console.log("VERIFIER=%s", address(verifier));
    }
}
