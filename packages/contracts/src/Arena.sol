// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IGate} from "./Gate.sol";

/// @title Arena — parimutuel casino over AI-generated events.
/// @notice An event has n outcomes. Each outcome index is an implicit binary YES/NO market.
///         One drand quicknet round, fixed at creation, resolves every market of the event:
///         outcome = keccak256(signature ‖ eventId) mod n. Winners split the market's pool
///         pro rata, less FEE_BPS to the treasury. Markets with an empty winning pool refund.
contract Arena is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 200;
    uint8 public constant NO = 0;
    uint8 public constant YES = 1;

    // drand quicknet: round r is published at DRAND_GENESIS + (r - 1) * DRAND_PERIOD.
    uint64 public constant DRAND_GENESIS = 1692803367;
    uint64 public constant DRAND_PERIOD = 3;
    /// @notice Betting must lock at least this long before the deciding round is published.
    uint64 public constant SUSPENSE_GAP = 10;

    struct EventData {
        uint8 nOutcomes;
        uint64 lockTime;
        uint64 drandRound;
        bool resolved;
        uint8 outcome;
        bytes signature; // drand BLS signature for drandRound, stored at resolve
    }

    IERC20 public immutable usdc;
    IGate public immutable gate;
    address public resolver;
    address public treasury;

    mapping(bytes32 => EventData) public events;
    /// @dev eventId => outcome index => [NO pool, YES pool]
    mapping(bytes32 => mapping(uint8 => uint256[2])) public pools;
    /// @dev eventId => outcome index => bettor => [NO stake, YES stake]; zeroed on claim
    mapping(bytes32 => mapping(uint8 => mapping(address => uint256[2]))) public stakes;

    event EventCreated(bytes32 indexed eventId, uint8 nOutcomes, uint64 lockTime, uint64 drandRound);
    event Bet(bytes32 indexed eventId, address indexed bettor, uint8 outcomeIdx, bool yes, uint256 amount);
    event Resolved(bytes32 indexed eventId, uint8 outcome, bytes signature);
    event Claimed(bytes32 indexed eventId, address indexed bettor, uint256 payout, uint256 fee);
    event ResolverSet(address resolver);
    event TreasurySet(address treasury);

    error NotResolver();
    error EventExists();
    error UnknownEvent();
    error BadOutcomeCount();
    error BadLockTime();
    error BadRound();
    error BettingClosed();
    error BettingOpen();
    error BadOutcome();
    error ZeroAmount();
    error NotVerified();
    error AlreadyResolved();
    error NotResolved();
    error BadSignature();
    error NothingToClaim();

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    constructor(IERC20 _usdc, IGate _gate, address _resolver, address _treasury) Ownable(msg.sender) {
        usdc = _usdc;
        gate = _gate;
        resolver = _resolver;
        treasury = _treasury;
    }

    // ── admin ──────────────────────────────────────────────────────────────

    function setResolver(address r) external onlyOwner {
        resolver = r;
        emit ResolverSet(r);
    }

    function setTreasury(address t) external onlyOwner {
        treasury = t;
        emit TreasurySet(t);
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    /// @notice Open an event. The deciding drand round is committed here, before any bet.
    function createEvent(bytes32 eventId, uint8 nOutcomes, uint64 lockTime, uint64 drandRound) external onlyResolver {
        if (events[eventId].lockTime != 0) revert EventExists();
        if (nOutcomes < 2 || nOutcomes > 8) revert BadOutcomeCount();
        if (lockTime <= block.timestamp) revert BadLockTime();
        if (drandRound == 0 || roundTime(drandRound) < lockTime + SUSPENSE_GAP) revert BadRound();
        events[eventId] = EventData(nOutcomes, lockTime, drandRound, false, 0, "");
        emit EventCreated(eventId, nOutcomes, lockTime, drandRound);
    }

    function bet(bytes32 eventId, uint8 outcomeIdx, bool yes, uint256 amount) external {
        EventData storage e = events[eventId];
        if (e.lockTime == 0) revert UnknownEvent();
        if (block.timestamp >= e.lockTime) revert BettingClosed();
        if (outcomeIdx >= e.nOutcomes) revert BadOutcome();
        if (amount == 0) revert ZeroAmount();
        if (!gate.verified(msg.sender)) revert NotVerified();
        uint8 side = yes ? YES : NO;
        pools[eventId][outcomeIdx][side] += amount;
        stakes[eventId][outcomeIdx][msg.sender][side] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Bet(eventId, msg.sender, outcomeIdx, yes, amount);
    }

    /// @notice Submit the drand signature for the committed round. v1 trusts the resolver;
    ///         the signature is stored so anyone can check it against the drand API.
    function resolve(bytes32 eventId, bytes calldata signature) external onlyResolver {
        EventData storage e = events[eventId];
        if (e.lockTime == 0) revert UnknownEvent();
        if (block.timestamp < e.lockTime) revert BettingOpen();
        if (e.resolved) revert AlreadyResolved();
        if (signature.length != 48) revert BadSignature(); // quicknet: compressed G1 point
        uint8 outcome = deriveOutcome(signature, eventId, e.nOutcomes);
        e.resolved = true;
        e.outcome = outcome;
        e.signature = signature;
        emit Resolved(eventId, outcome, signature);
    }

    /// @notice Pay out every market of the event the caller won (or is refunded on).
    function claim(bytes32 eventId) external {
        EventData storage e = events[eventId];
        if (!e.resolved) revert NotResolved();
        uint256 payout;
        uint256 fee;
        for (uint8 i = 0; i < e.nOutcomes; i++) {
            uint8 win = i == e.outcome ? YES : NO;
            uint256[2] storage p = pools[eventId][i];
            uint256[2] storage s = stakes[eventId][i][msg.sender];
            if (p[win] == 0) {
                payout += s[1 - win]; // nobody to pay the losers' money to: refund in full
            } else {
                uint256 gross = s[win] * (p[NO] + p[YES]) / p[win];
                uint256 f = gross * FEE_BPS / 10_000;
                payout += gross - f;
                fee += f;
            }
            delete stakes[eventId][i][msg.sender];
        }
        if (payout == 0) revert NothingToClaim();
        usdc.safeTransfer(msg.sender, payout);
        if (fee > 0) usdc.safeTransfer(treasury, fee);
        emit Claimed(eventId, msg.sender, payout, fee);
    }

    // ── views ──────────────────────────────────────────────────────────────

    function deriveOutcome(bytes memory signature, bytes32 eventId, uint8 nOutcomes) public pure returns (uint8) {
        return uint8(uint256(keccak256(abi.encodePacked(signature, eventId))) % nOutcomes);
    }

    function roundTime(uint64 round) public pure returns (uint64) {
        return DRAND_GENESIS + (round - 1) * DRAND_PERIOD;
    }

    /// @notice Smallest round published at or after `t`.
    function roundAt(uint64 t) public pure returns (uint64) {
        if (t <= DRAND_GENESIS) return 1;
        return (t - DRAND_GENESIS + DRAND_PERIOD - 1) / DRAND_PERIOD + 1;
    }
}
