// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DrandVerifier} from "../src/DrandVerifier.sol";

/// Fixtures are real drand `evmnet` beacons, pinned from
/// `curl https://api.drand.sh/v2/beacons/evmnet/rounds/<round>` on 2026-09-09.
contract DrandVerifierTest is Test {
    uint64 constant ROUND = 20456251;
    bytes constant SIG =
        hex"1a909b075202e693fc0e3bd141bbb24fce116a6ffb4343674417b89de6c658492379ad0c3a0c34a4ac46b9130948e781e527430db6240fef8253931abbb7f768";
    uint64 constant ROUND2 = 20456252;
    bytes constant SIG2 =
        hex"1c4598779baab0fd24c12d33883eaf6e3b76cc7972d45d30876b2518acc75627278c2368c015a912365e4ca4e06bdab0e6042c72f0449824e4589fdeeb46fa0d";

    DrandVerifier v;

    function setUp() public {
        v = new DrandVerifier();
    }

    function test_MessageIsKeccakOfBigEndianRound() public view {
        assertEq(v.messageOf(ROUND), keccak256(abi.encodePacked(bytes8(ROUND))));
    }

    function test_VerifiesRealBeacons() public view {
        assertTrue(v.verify(ROUND, SIG));
        assertTrue(v.verify(ROUND2, SIG2));
    }

    /// Flipping the lowest bit of y keeps the encoding well-formed but leaves the curve.
    function test_RejectsTamperedSignature() public view {
        bytes memory bad = SIG;
        bad[63] = bytes1(uint8(bad[63]) ^ 0x01);
        assertFalse(v.verify(ROUND, bad));
    }

    /// A genuine beacon for the neighbouring round must not pass: this exercises the pairing
    /// rejection path, not the cheap on-curve pre-check.
    function test_RejectsSignatureFromAnotherRound() public view {
        assertFalse(v.verify(ROUND, SIG2));
        assertFalse(v.verify(ROUND2, SIG));
    }

    function test_RejectsWrongLength() public view {
        assertFalse(v.verify(ROUND, hex"00"));
        assertFalse(v.verify(ROUND, abi.encodePacked(SIG, hex"00")));
    }

    function test_GasOfVerify() public {
        uint256 before = gasleft();
        v.verify(ROUND, SIG);
        uint256 used = before - gasleft();
        emit log_named_uint("DrandVerifier.verify gas", used);
        assertLt(used, 250_000);
    }
}
