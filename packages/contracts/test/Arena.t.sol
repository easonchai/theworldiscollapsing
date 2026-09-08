// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Gate} from "../src/Gate.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {Arena} from "../src/Arena.sol";

contract ArenaTest is Test {
    // Real drand quicknet beacon, round 32026121 (2026-09-08T15:35:27Z).
    // Reference hash computed off-chain: cast keccak 0x<sig><eventId>.
    bytes constant SIG =
        hex"86da6c35d9cad6916a54c9a0679f031bc5dd6ec3515a5d4eaa512077fd9fb97164c1838a9ad6ac70a00f36f016c86977";
    bytes32 constant EID = keccak256("sports:1"); // 0xfa9065743d1211e328d8534fe669e4f60e9a24fec6efb614d9add44c96f9b674
    bytes32 constant HASH = 0x2e085a78ceaf8e9d17b6ea974972338a20bd486dbbd4386bb181bd1a709f9991;

    uint256 constant T0 = 1_788_912_000;

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
        assertEq(arena.deriveOutcome(SIG, EID, 2), 1);
        assertEq(arena.deriveOutcome(SIG, EID, 3), 1);
        assertEq(arena.deriveOutcome(SIG, EID, 5), 4);

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
        assertEq(arena.roundTime(1), arena.DRAND_GENESIS());
        assertEq(arena.roundTime(32026121), 1_788_881_727);
        assertEq(arena.roundAt(1_788_881_727), 32026121);
        assertEq(arena.roundAt(1_788_881_726), 32026121);
        assertEq(arena.roundAt(1_788_881_728), 32026122);
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
}
