// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Gate} from "../src/Gate.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {Arena} from "../src/Arena.sol";
import {DrandVerifier} from "../src/DrandVerifier.sol";

contract ArenaTest is Test {
    // Real drand evmnet beacon, round 20456251 (published 1788889825).
    // Reference hash computed off-chain: cast keccak 0x<sig><eventId>.
    uint64 constant ROUND = 20456251;
    bytes constant SIG =
        hex"1a909b075202e693fc0e3bd141bbb24fce116a6ffb4343674417b89de6c658492379ad0c3a0c34a4ac46b9130948e781e527430db6240fef8253931abbb7f768";
    // Genuine beacon of the next round — a valid signature for the wrong round.
    bytes constant SIG2 =
        hex"1c4598779baab0fd24c12d33883eaf6e3b76cc7972d45d30876b2518acc75627278c2368c015a912365e4ca4e06bdab0e6042c72f0449824e4589fdeeb46fa0d";
    bytes32 constant EID = keccak256("sports:1"); // 0xfa9065743d1211e328d8534fe669e4f60e9a24fec6efb614d9add44c96f9b674
    bytes32 constant HASH = 0x206ce67f980f0f6700f2dcec72773785f358e984441ddd6e5748246bfe33f9aa;

    // 300 s before round ROUND is published, so `open()` commits a round in the near future.
    uint256 constant T0 = 1_788_889_525;

    Gate gate;
    MockUSDC usdc;
    Arena arena;
    address treasury = makeAddr("treasury");
    address alice;
    address bob;
    address carol;

    function setUp() public {
        vm.warp(T0);
        gate = new Gate(address(this));
        usdc = new MockUSDC(gate);
        arena = new Arena(usdc, gate, address(this), treasury);
        alice = mk("alice");
        bob = mk("bob");
        carol = mk("carol");
    }

    // ── helpers ────────────────────────────────────────────────────────────

    function mk(string memory name) internal returns (address a) {
        a = makeAddr(name);
        gate.setVerified(a, true);
        vm.startPrank(a);
        usdc.faucet();
        usdc.approve(address(arena), type(uint256).max);
        vm.stopPrank();
    }

    function open(bytes32 id, uint8 n) internal returns (uint64 lock) {
        lock = uint64(block.timestamp + 60);
        arena.createEvent(id, n, lock, arena.roundAt(lock + arena.SUSPENSE_GAP()));
    }

    function betAs(address who, bytes32 id, uint8 idx, bool yes, uint256 amt) internal {
        vm.prank(who);
        arena.bet(id, idx, yes, amt);
    }

    function lockAndResolve(bytes32 id, uint64 lock) internal {
        vm.warp(lock);
        arena.resolve(id, SIG);
    }

    function claimAs(address who, bytes32 id) internal returns (uint256 got) {
        uint256 before = usdc.balanceOf(who);
        vm.prank(who);
        arena.claim(id);
        got = usdc.balanceOf(who) - before;
    }

    function expectNoClaim(address who, bytes32 id) internal {
        vm.prank(who);
        vm.expectRevert(Arena.NothingToClaim.selector);
        arena.claim(id);
    }

    function win(bytes32 id, uint8 n) internal view returns (uint8) {
        return arena.deriveOutcome(SIG, id, n);
    }

    // ── tests ──────────────────────────────────────────────────────────────

    function test_PoolsAccumulateAcrossYesAndNo() public {
        bytes32 id = keccak256("e1");
        open(id, 3);
        betAs(alice, id, 0, true, 10e6);
        betAs(bob, id, 0, true, 5e6);
        betAs(carol, id, 0, false, 7e6);
        betAs(alice, id, 1, false, 1e6);
        assertEq(arena.pools(id, 0, arena.YES()), 15e6);
        assertEq(arena.pools(id, 0, arena.NO()), 7e6);
        assertEq(arena.pools(id, 1, arena.NO()), 1e6);
        assertEq(arena.pools(id, 1, arena.YES()), 0);
        assertEq(arena.stakes(id, 0, alice, arena.YES()), 10e6);
        assertEq(arena.stakes(id, 1, alice, arena.NO()), 1e6);
        assertEq(usdc.balanceOf(address(arena)), 23e6);
    }

    function test_BetRejectedAtAndAfterLock() public {
        bytes32 id = keccak256("e2");
        uint64 lock = open(id, 2);
        vm.warp(lock);
        vm.expectRevert(Arena.BettingClosed.selector);
        betAs(alice, id, 0, true, 1e6);
        vm.warp(lock + 1000);
        vm.expectRevert(Arena.BettingClosed.selector);
        betAs(alice, id, 0, true, 1e6);
    }

    function test_ResolveRejectedBeforeLock() public {
        bytes32 id = keccak256("e3");
        uint64 lock = open(id, 2);
        vm.warp(lock - 1);
        vm.expectRevert(Arena.BettingOpen.selector);
        arena.resolve(id, SIG);
    }

    function test_KnownSignatureDerivation() public {
        assertEq(keccak256(abi.encodePacked(SIG, EID)), HASH);
        assertEq(arena.deriveOutcome(SIG, EID, 2), 0);
        assertEq(arena.deriveOutcome(SIG, EID, 3), 1);
        assertEq(arena.deriveOutcome(SIG, EID, 5), 1);

        uint64 lock = open(EID, 3);
        lockAndResolve(EID, lock);
        (,,, bool resolved, uint8 outcome, bytes memory sig) = arena.events(EID);
        assertTrue(resolved);
        assertEq(outcome, 1);
        assertEq(sig, SIG);
    }

    function test_PayoutMathAndDustStaysInContract() public {
        bytes32 id = keccak256("e5");
        uint8 w = win(id, 2);
        uint64 lock = open(id, 2);
        betAs(alice, id, w, true, 10e6);
        betAs(bob, id, w, true, 20e6);
        betAs(carol, id, w, false, 7e6);
        lockAndResolve(id, lock);
        // total 37e6, winning 30e6
        // alice gross = 10e6*37e6/30e6 = 12_333_333, fee 246_666
        // bob   gross = 20e6*37e6/30e6 = 24_666_666, fee 493_333
        assertEq(claimAs(alice, id), 12_086_667);
        assertEq(claimAs(bob, id), 24_173_333);
        assertEq(usdc.balanceOf(treasury), 739_999);
        assertEq(usdc.balanceOf(address(arena)), 1);
    }

    function test_ClaimIsIdempotentAndRejectedForLosers() public {
        bytes32 id = keccak256("e6");
        uint8 w = win(id, 2);
        uint64 lock = open(id, 2);
        betAs(alice, id, w, true, 10e6);
        betAs(carol, id, w, false, 7e6);
        lockAndResolve(id, lock);
        claimAs(alice, id);
        expectNoClaim(alice, id);
        expectNoClaim(carol, id);
    }

    function test_RefundWhenWinningPoolEmpty() public {
        bytes32 id = keccak256("e7");
        uint8 w = win(id, 2);
        uint64 lock = open(id, 2);
        betAs(alice, id, w, false, 10e6);
        betAs(bob, id, w, false, 5e6);
        lockAndResolve(id, lock);
        assertEq(claimAs(alice, id), 10e6);
        assertEq(claimAs(bob, id), 5e6);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(arena)), 0);
    }

    function test_CannotResolveTwice() public {
        bytes32 id = keccak256("e8");
        uint64 lock = open(id, 2);
        lockAndResolve(id, lock);
        vm.expectRevert(Arena.AlreadyResolved.selector);
        arena.resolve(id, SIG);
    }

    function test_FeeAccruesToTreasury() public {
        bytes32 id = keccak256("e9");
        uint8 w = win(id, 2);
        uint64 lock = open(id, 2);
        betAs(alice, id, w, true, 100e6);
        betAs(carol, id, w, false, 100e6);
        lockAndResolve(id, lock);
        assertEq(claimAs(alice, id), 196e6);
        assertEq(usdc.balanceOf(treasury), 4e6);
    }

    function test_OneSignatureResolvesAllMarketsWithExactlyOneYes() public {
        bytes32 id = keccak256("e10");
        uint64 lock = open(id, 3);
        address[3] memory yes;
        address[3] memory no;
        for (uint8 i = 0; i < 3; i++) {
            yes[i] = mk(string(abi.encodePacked("yes", i)));
            no[i] = mk(string(abi.encodePacked("no", i)));
            betAs(yes[i], id, i, true, 10e6);
            betAs(no[i], id, i, false, 10e6);
        }
        lockAndResolve(id, lock);
        (,,,, uint8 outcome,) = arena.events(id);
        uint256 yesWinners;
        for (uint8 i = 0; i < 3; i++) {
            if (i == outcome) {
                assertEq(claimAs(yes[i], id), 19_600_000);
                expectNoClaim(no[i], id);
                yesWinners++;
            } else {
                assertEq(claimAs(no[i], id), 19_600_000);
                expectNoClaim(yes[i], id);
            }
        }
        assertEq(yesWinners, 1);
    }

    function test_CreateEventGuards() public {
        bytes32 id = keccak256("e11");
        uint64 lock = uint64(block.timestamp + 60);
        uint64 round = arena.roundAt(lock + arena.SUSPENSE_GAP());

        vm.prank(alice);
        vm.expectRevert(Arena.NotResolver.selector);
        arena.createEvent(id, 2, lock, round);

        vm.expectRevert(Arena.BadOutcomeCount.selector);
        arena.createEvent(id, 1, lock, round);

        vm.expectRevert(Arena.BadLockTime.selector);
        arena.createEvent(id, 2, uint64(block.timestamp), round);

        vm.expectRevert(Arena.BadRound.selector);
        arena.createEvent(id, 2, lock, round - 1);

        arena.createEvent(id, 2, lock, round);
        vm.expectRevert(Arena.EventExists.selector);
        arena.createEvent(id, 2, lock, round);
    }

    function test_RoundMath() public view {
        // round r is published at genesis + (r-1)*3
        assertEq(arena.DRAND_GENESIS(), 1_727_521_075); // drand evmnet genesis_time
        assertEq(arena.roundTime(1), arena.DRAND_GENESIS());
        assertEq(arena.roundTime(ROUND), 1_788_889_825);
        assertEq(arena.roundAt(1_788_889_825), ROUND);
        assertEq(arena.roundAt(1_788_889_824), ROUND);
        assertEq(arena.roundAt(1_788_889_826), ROUND + 1);
        assertEq(arena.roundAt(0), 1);
    }

    function test_UnverifiedCannotBetOrFaucet() public {
        bytes32 id = keccak256("e12");
        open(id, 2);
        address mallory = makeAddr("mallory");
        vm.startPrank(mallory);
        vm.expectRevert(MockUSDC.NotVerified.selector);
        usdc.faucet();
        vm.expectRevert(Arena.NotVerified.selector);
        arena.bet(id, 0, true, 1);
        vm.stopPrank();
    }

    function test_FaucetCooldown() public {
        vm.startPrank(alice);
        vm.expectRevert(MockUSDC.FaucetCooldown.selector);
        usdc.faucet();
        vm.warp(block.timestamp + 1 days);
        usdc.faucet();
        vm.stopPrank();
        assertEq(usdc.balanceOf(alice), 2 * usdc.FAUCET_AMOUNT());
    }

    function test_ResolveRejectsBadSignatureLength() public {
        bytes32 id = keccak256("e13");
        uint64 lock = open(id, 2);
        vm.warp(lock);
        vm.expectRevert(Arena.BadSignature.selector);
        arena.resolve(id, hex"00");
    }

    // ── on-chain beacon verification ───────────────────────────────────────

    /// Open an event whose committed round is the pinned real beacon, then warp past its lock.
    function openAtPinnedRound(bytes32 id, uint8 n) internal returns (uint64 lock) {
        lock = uint64(block.timestamp + 60);
        require(arena.roundTime(ROUND) >= lock + arena.SUSPENSE_GAP(), "fixture round too early");
        arena.createEvent(id, n, lock, ROUND);
        vm.warp(lock);
    }

    function test_VerifierIsOffByDefault() public view {
        assertEq(address(arena.verifier()), address(0));
    }

    function test_SetVerifierIsOwnerOnly() public {
        DrandVerifier v = new DrandVerifier();
        vm.prank(alice);
        vm.expectRevert();
        arena.setVerifier(v);
        arena.setVerifier(v);
        assertEq(address(arena.verifier()), address(v));
    }

    function test_ResolveWithVerifierAcceptsRealBeacon() public {
        arena.setVerifier(new DrandVerifier());
        bytes32 id = keccak256("v1");
        openAtPinnedRound(id, 3);
        uint256 before = gasleft();
        arena.resolve(id, SIG);
        emit log_named_uint("Arena.resolve gas (verified)", before - gasleft());
        (,,, bool resolved, uint8 outcome,) = arena.events(id);
        assertTrue(resolved);
        assertEq(outcome, arena.deriveOutcome(SIG, id, 3));
    }

    function test_ResolveWithVerifierRejectsTamperedSignature() public {
        arena.setVerifier(new DrandVerifier());
        bytes32 id = keccak256("v2");
        openAtPinnedRound(id, 3);
        bytes memory bad = SIG;
        bad[63] = bytes1(uint8(bad[63]) ^ 0x01);
        vm.expectRevert(Arena.BadSignature.selector);
        arena.resolve(id, bad);
    }

    /// SIG2 is a genuine beacon — for round ROUND + 1, not the round this event committed.
    function test_ResolveWithVerifierRejectsWrongRound() public {
        arena.setVerifier(new DrandVerifier());
        bytes32 id = keccak256("v3");
        openAtPinnedRound(id, 3);
        vm.expectRevert(Arena.BadSignature.selector);
        arena.resolve(id, SIG2);
    }

    function test_ResolveGasInTrustedMode() public {
        bytes32 id = keccak256("v4");
        uint64 lock = open(id, 3);
        vm.warp(lock);
        uint256 before = gasleft();
        arena.resolve(id, SIG);
        emit log_named_uint("Arena.resolve gas (trusted)", before - gasleft());
    }
}
