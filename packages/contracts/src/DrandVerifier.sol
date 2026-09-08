// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IDrandVerifier {
    /// @notice True iff `signature` is the drand beacon signature for `round`.
    function verify(uint64 round, bytes calldata signature) external view returns (bool);
}

/// @title DrandVerifier — on-chain BLS verification of drand `evmnet` beacons.
/// @notice evmnet is drand's BN254 network (`bls-bn254-unchained-on-g1`): signatures are
///         uncompressed G1 points (64 bytes), the group public key is a G2 point, and the
///         signed message of round r is `keccak256(uint64be(r))` hashed to G1 with
///         DST `BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_`. Verification is the pairing
///         check e(sig, -g2) · e(H(m), pk) == 1, which BN254 precompiles 0x06/0x08 make cheap.
/// @dev The hash-to-curve and pairing code is adapted from randa-mu/blocklock-solidity
///      `src/libraries/BLS.sol` (MIT), itself adapted from kevincharm/bls-bn254. Trimmed to the
///      functions this contract uses; `ModexpInverse`/`ModexpSqrt` are replaced by the modexp
///      precompile (0x05), which is both smaller and cheaper than their unrolled addition chains.
contract DrandVerifier is IDrandVerifier {
    /// @dev BN254 field order.
    uint256 private constant P = 21888242871839275222246405745257275088696311157297823662689037894645226208583;
    /// @dev (P + 1) / 4 — square-root exponent, valid because P % 4 == 3.
    uint256 private constant SQRT_EXP = 0xc19139cb84c680a6e14116da060561765e05aa45a1c72a34f082305b61f3f52;
    /// @dev P - 2 — inversion exponent (Fermat).
    uint256 private constant INV_EXP = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd45;
    /// @dev (P - 1) / 2 — Legendre exponent.
    uint256 private constant LEG_EXP = 0x183227397098d014dc2822db40c0ac2ecbc0b548b438e5469e10460b6c3e7ea3;

    // Negated generator of G2, in the (imaginary, real) order the pairing precompile wants.
    uint256 private constant N_G2_X1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 private constant N_G2_X0 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 private constant N_G2_Y1 = 17805874995975841540914202342111839520379459829704422454583296818431106115052;
    uint256 private constant N_G2_Y0 = 13392588948715843804641432497768002650278120570034223513918757245338268106653;

    /// @notice drand `evmnet` group public key, from
    ///         `GET https://api.drand.sh/v2/beacons/evmnet/info` (chain hash
    ///         04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3).
    ///         The 128-byte key marshals as x.c1 ‖ x.c0 ‖ y.c1 ‖ y.c0.
    uint256 private constant PK_X1 = 0x07e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382;
    uint256 private constant PK_X0 = 0x0557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f;
    uint256 private constant PK_Y1 = 0x0095685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6;
    uint256 private constant PK_Y0 = 0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b;

    bytes private constant DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";

    // SVDW map constants for E: y^2 = x^3 + 3 with Z = 1 (see RFC 9380 §6.6.1).
    uint256 private constant B = 3;
    uint256 private constant Z = 1;
    uint256 private constant C1 = 0x4; // g(Z)
    uint256 private constant C2 = 0x183227397098d014dc2822db40c0ac2ecbc0b548b438e5469e10460b6c3e7ea3; // -Z/2
    uint256 private constant C3 = 0x16789af3a83522eb353c98fc6b36d713d5d8d1cc5dffffffa; // sqrt(-g(Z)(3Z^2+4A))
    uint256 private constant C4 = 0x10216f7ba065e00de81ac1e7808072c9dd2b2385cd7b438469602eb24829a9bd; // 4·-g(Z)/(3Z^2+4A)

    uint256 private constant T24 = 0x1000000000000000000000000000000000000000000000000;
    uint256 private constant MASK24 = 0xffffffffffffffffffffffffffffffffffffffffffffffff;

    error MapToPointFailed(uint256 v);
    error PrecompileFailed(uint8 addr);

    /// @inheritdoc IDrandVerifier
    function verify(uint64 round, bytes calldata signature) external view returns (bool) {
        if (signature.length != 64) return false;
        uint256 sx;
        uint256 sy;
        assembly {
            sx := calldataload(signature.offset)
            sy := calldataload(add(signature.offset, 32))
        }
        if (sx >= P || sy >= P || !onCurve(sx, sy)) return false;
        (uint256 mx, uint256 my) = hashToPoint(messageOf(round));
        uint256[12] memory input =
            [sx, sy, N_G2_X1, N_G2_X0, N_G2_Y1, N_G2_Y0, mx, my, PK_X1, PK_X0, PK_Y1, PK_Y0];
        uint256[1] memory out;
        bool ok;
        assembly {
            ok := staticcall(gas(), 8, input, 384, out, 0x20)
        }
        if (!ok) revert PrecompileFailed(8);
        return out[0] == 1;
    }

    /// @notice The message drand signs for `round` in an unchained scheme: keccak256 of the
    ///         round number as a big-endian uint64.
    function messageOf(uint64 round) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(round));
    }

    // ── hash to curve (RFC 9380, expand_message_xmd with keccak256 + SVDW) ─────

    function hashToPoint(bytes32 message) internal view returns (uint256 x, uint256 y) {
        (uint256 u0, uint256 u1) = hashToField(message);
        (uint256 ax, uint256 ay) = mapToPoint(u0);
        (uint256 bx, uint256 by) = mapToPoint(u1);
        uint256[4] memory input = [ax, ay, bx, by];
        uint256[2] memory out;
        bool ok;
        assembly {
            ok := staticcall(gas(), 6, input, 128, out, 64)
        }
        if (!ok) revert PrecompileFailed(6);
        return (out[0], out[1]);
    }

    function hashToField(bytes32 message) internal pure returns (uint256 a0, uint256 a1) {
        bytes memory m = expandMsgTo96(message);
        assembly {
            let p := add(m, 24)
            let hi := and(mload(p), MASK24)
            p := add(m, 48)
            let lo := and(mload(p), MASK24)
            a0 := addmod(mulmod(hi, T24, P), lo, P)
            p := add(m, 72)
            hi := and(mload(p), MASK24)
            p := add(m, 96)
            lo := and(mload(p), MASK24)
            a1 := addmod(mulmod(hi, T24, P), lo, P)
        }
    }

    /// @dev expand_message_xmd (RFC 9380 §5.3.1) with H = keccak256, b_in_bytes = 32,
    ///      s_in_bytes = 136 (keccak rate), len_in_bytes = 96.
    function expandMsgTo96(bytes32 message) internal pure returns (bytes memory out) {
        bytes memory dst = DST;
        uint8 dstLen = uint8(dst.length);
        bytes32 b0 = keccak256(abi.encodePacked(new bytes(136), message, uint8(0), uint8(96), uint8(0), dst, dstLen));
        bytes32 b1 = keccak256(abi.encodePacked(b0, uint8(1), dst, dstLen));
        bytes32 b2 = keccak256(abi.encodePacked(b0 ^ b1, uint8(2), dst, dstLen));
        bytes32 b3 = keccak256(abi.encodePacked(b0 ^ b2, uint8(3), dst, dstLen));
        out = abi.encodePacked(b1, b2, b3);
    }

    /// @dev Shallue–van de Woestijne map to E(Fp), per RFC 9380 §6.6.1.
    function mapToPoint(uint256 u) internal view returns (uint256 x, uint256 y) {
        uint256 tv1 = mulmod(mulmod(u, u, P), C1, P);
        uint256 tv2 = addmod(1, tv1, P);
        tv1 = addmod(1, P - tv1, P);
        uint256 tv3 = modexp(mulmod(tv1, tv2, P), INV_EXP);
        uint256 tv5 = mulmod(mulmod(mulmod(u, tv1, P), tv3, P), C3, P);
        uint256 x1 = addmod(C2, P - tv5, P);
        uint256 x2 = addmod(C2, tv5, P);
        uint256 tv7 = mulmod(tv2, tv2, P);
        uint256 tv8 = mulmod(tv7, tv3, P);
        uint256 x3 = addmod(Z, mulmod(C4, mulmod(tv8, tv8, P), P), P);

        x = isSquare(g(x1)) ? x1 : isSquare(g(x2)) ? x2 : x3;
        uint256 gx = g(x);
        y = modexp(gx, SQRT_EXP);
        if (mulmod(y, y, P) != gx) revert MapToPointFailed(gx);
        if (u % 2 != y % 2) y = P - y;
    }

    function g(uint256 x) private pure returns (uint256) {
        return addmod(mulmod(mulmod(x, x, P), x, P), B, P);
    }

    function onCurve(uint256 x, uint256 y) private pure returns (bool) {
        return mulmod(y, y, P) == g(x);
    }

    /// @dev Legendre symbol: u^((P-1)/2) is 1 for a quadratic residue, P-1 for a non-residue,
    ///      0 for u ≡ 0. Anything else means the modexp precompile lied.
    function isSquare(uint256 u) private view returns (bool) {
        uint256 r = modexp(u, LEG_EXP);
        if (r > 1 && r != P - 1) revert MapToPointFailed(u);
        return r == 1;
    }

    /// @dev base^exp mod P via the modexp precompile (0x05).
    function modexp(uint256 base, uint256 e) private view returns (uint256 result) {
        bool ok;
        assembly {
            let p := mload(0x40)
            mstore(p, 32)
            mstore(add(p, 32), 32)
            mstore(add(p, 64), 32)
            mstore(add(p, 96), base)
            mstore(add(p, 128), e)
            mstore(add(p, 160), P)
            ok := staticcall(gas(), 5, p, 192, p, 32)
            result := mload(p)
        }
        if (!ok) revert PrecompileFailed(5);
    }
}
