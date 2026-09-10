// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IGate} from "./Gate.sol";
import {IDrandVerifier} from "./DrandVerifier.sol";

/// @title Arena — parimutuel casino over AI-generated events.
/// @notice An event has n outcomes. Each outcome index is an implicit binary YES/NO market.
///         One drand evmnet round, fixed at creation, resolves every market of the event:
///         outcome = keccak256(signature ‖ eventId) mod n. Winners split the market's pool
///         pro rata, less FEE_BPS to the treasury. Markets with an empty winning pool refund.
contract Arena is Ownable {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 200;
    uint8 public constant NO = 0;
    uint8 public constant YES = 1;
    /// @notice Smallest bet, in USDC's 6 decimals: 1 USDC. `claim` refunds a market whose winning
    ///         side is empty and pays winner-take-all when it holds anything at all, so without a
    ///         floor that switch is one micro-USDC wide: dust on the winning side of every outcome
    ///         costs nOutcomes micro-USDC and takes the losing pool of whichever outcome lands.
    ///         A stake worth taking that pool has to be worth losing too.
    uint256 public constant MIN_BET = 1e6;

    // drand evmnet: round r is published at DRAND_GENESIS + (r - 1) * DRAND_PERIOD.
    uint64 public constant DRAND_GENESIS = 1727521075;
    uint64 public constant DRAND_PERIOD = 3;
    /// @notice Betting must lock at least this long before the deciding round is published.
    uint64 public constant SUSPENSE_GAP = 10;
    /// @notice How long after `lockTime` an unresolved event may be bailed out and refunded.
    uint64 public constant BAIL_DELAY = 3 days;

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
    /// @notice On-chain drand beacon verifier. `address(0)` = trusted mode: the resolver's
    ///         signature is stored as submitted and only checked off-chain.
    IDrandVerifier public verifier;

    mapping(bytes32 => EventData) public events;
    /// @notice The verifier an event was created under, fixed at `createEvent`. `resolve` uses this,
    ///         not the current global `verifier`, so changing `verifier` cannot move the goalposts
    ///         for an event that is already taking bets. `address(0)` = trusted mode for that event.
    mapping(bytes32 => IDrandVerifier) public eventVerifier;
    /// @notice Set by `bail` once an event is past `lockTime + BAIL_DELAY` unresolved: `claim`
    ///         refunds stakes in full and `resolve` is closed for good.
    mapping(bytes32 => bool) public bailed;
    /// @dev eventId => outcome index => [NO pool, YES pool]
    mapping(bytes32 => mapping(uint8 => uint256[2])) public pools;
    /// @dev eventId => outcome index => bettor => [NO stake, YES stake]; zeroed on claim
    mapping(bytes32 => mapping(uint8 => mapping(address => uint256[2]))) public stakes;

    event EventCreated(bytes32 indexed eventId, uint8 nOutcomes, uint64 lockTime, uint64 drandRound);
    event Bet(bytes32 indexed eventId, address indexed bettor, uint8 outcomeIdx, bool yes, uint256 amount);
    event Resolved(bytes32 indexed eventId, uint8 outcome, bytes signature);
    event Claimed(bytes32 indexed eventId, address indexed bettor, uint256 payout, uint256 fee);
    event Bailed(bytes32 indexed eventId);
    event ResolverSet(address resolver);
    event TreasurySet(address treasury);
    event VerifierSet(address verifier);

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
    error BelowMinBet();
    error NotVerified();
    error AlreadyResolved();
    error NotResolved();
    error BadSignature();
    error NothingToClaim();
    error RoundNotPublished();
    error BailTooEarly();
    /// @dev `Bailed` is taken by the event of the same name; Solidity shares one namespace.
    error EventBailed();

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

    /// @notice Point resolution at an on-chain beacon verifier, or `address(0)` for trusted mode.
    ///         Only events created after this call are affected; existing ones keep the verifier
    ///         they were created under (`eventVerifier`).
    function setVerifier(IDrandVerifier v) external onlyOwner {
        verifier = v;
        emit VerifierSet(address(v));
    }

    // ── lifecycle ──────────────────────────────────────────────────────────

    /// @notice Open an event. The deciding drand round *and* the verifier that will check it are
    ///         committed here, before any bet.
    function createEvent(bytes32 eventId, uint8 nOutcomes, uint64 lockTime, uint64 drandRound) external onlyResolver {
        if (events[eventId].lockTime != 0) revert EventExists();
        if (nOutcomes < 2 || nOutcomes > 8) revert BadOutcomeCount();
        if (lockTime <= block.timestamp) revert BadLockTime();
        if (drandRound == 0 || roundTime(drandRound) < lockTime + SUSPENSE_GAP) revert BadRound();
        events[eventId] = EventData(nOutcomes, lockTime, drandRound, false, 0, "");
        eventVerifier[eventId] = verifier;
        emit EventCreated(eventId, nOutcomes, lockTime, drandRound);
    }

    function bet(bytes32 eventId, uint8 outcomeIdx, bool yes, uint256 amount) external {
        EventData storage e = events[eventId];
        if (e.lockTime == 0) revert UnknownEvent();
        if (block.timestamp >= e.lockTime) revert BettingClosed();
        if (outcomeIdx >= e.nOutcomes) revert BadOutcome();
        if (amount == 0) revert ZeroAmount();
        if (amount < MIN_BET) revert BelowMinBet();
        if (!gate.verified(msg.sender)) revert NotVerified();
        uint8 side = yes ? YES : NO;
        pools[eventId][outcomeIdx][side] += amount;
        stakes[eventId][outcomeIdx][msg.sender][side] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Bet(eventId, msg.sender, outcomeIdx, yes, amount);
    }

    /// @notice Submit the drand signature for the committed round. When the event was created with
    ///         a verifier the signature is checked on chain, so resolution no longer trusts the
    ///         resolver; it is stored either way so anyone can check it against the drand API.
    ///         In trusted mode there is nothing to check the signature against, so the one thing
    ///         that can be checked is the clock: the committed round must already be published.
    function resolve(bytes32 eventId, bytes calldata signature) external onlyResolver {
        EventData storage e = events[eventId];
        if (e.lockTime == 0) revert UnknownEvent();
        if (block.timestamp < e.lockTime) revert BettingOpen();
        if (e.resolved) revert AlreadyResolved();
        if (bailed[eventId]) revert EventBailed();
        if (signature.length != 64) revert BadSignature(); // evmnet: uncompressed BN254 G1 point
        IDrandVerifier v = eventVerifier[eventId];
        if (address(v) == address(0)) {
            if (block.timestamp < roundTime(e.drandRound)) revert RoundNotPublished();
        } else if (!v.verify(e.drandRound, signature)) {
            revert BadSignature();
        }
        uint8 outcome = deriveOutcome(signature, eventId, e.nOutcomes);
        e.resolved = true;
        e.outcome = outcome;
        e.signature = signature;
        emit Resolved(eventId, outcome, signature);
    }

    /// @notice Give up on an event nobody resolved and open it for refunds. Permissionless: the
    ///         resolver can stall a resolution, but only for `BAIL_DELAY` past the lock.
    function bail(bytes32 eventId) external {
        EventData storage e = events[eventId];
        if (e.lockTime == 0) revert UnknownEvent();
        if (e.resolved) revert AlreadyResolved();
        if (bailed[eventId]) revert EventBailed();
        if (block.timestamp <= e.lockTime + BAIL_DELAY) revert BailTooEarly();
        bailed[eventId] = true;
        emit Bailed(eventId);
    }

    /// @notice Pay out every market of the event the caller won (or is refunded on). On a bailed
    ///         event every stake comes back in full instead, no fee.
    function claim(bytes32 eventId) external {
        EventData storage e = events[eventId];
        bool refund = bailed[eventId];
        if (!refund && !e.resolved) revert NotResolved();
        uint256 payout;
        uint256 fee;
        for (uint8 i = 0; i < e.nOutcomes; i++) {
            uint256[2] storage s = stakes[eventId][i][msg.sender];
            if (refund) {
                payout += s[NO] + s[YES];
            } else {
                uint8 win = i == e.outcome ? YES : NO;
                uint256[2] storage p = pools[eventId][i];
                if (p[win] == 0) {
                    payout += s[1 - win]; // nobody to pay the losers' money to: refund in full
                } else {
                    uint256 gross = s[win] * (p[NO] + p[YES]) / p[win];
                    uint256 f = gross * FEE_BPS / 10_000;
                    payout += gross - f;
                    fee += f;
                }
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
