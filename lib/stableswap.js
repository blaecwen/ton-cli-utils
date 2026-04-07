/**
 * lib/stableswap.js — Weighted stableswap AMM math
 *
 * Exact 1:1 port of StonFi V2 weighted stableswap contracts + the
 * @ston-fi/funcbox fixed-point math library from FunC to JavaScript BigInt.
 *
 * Algorithm overview:
 *   The pool uses a weighted invariant:  k = (x + rate·y)·amp + x^p · (rate·y)^q
 *   where p = w0, q = 1−w0.  Swaps are computed by Newton-Raphson iteration:
 *   given reserves (x, y) and input dx, find dy such that k is preserved.
 *   Fractional powers (x^0.25 etc.) use exp(y·ln(x)) with lookup-table-based
 *   ln/exp — the same algorithm as Balancer V2's LogExpMath.sol.
 *
 * FunC → JS mapping:
 *   - muldiv(a, b, c) → a * b / c  (BigInt gives arbitrary precision, same as FunC's 512-bit intermediate)
 *   - FunC `/` is floor division; JS BigInt `/` truncates toward zero → fdiv() helper handles negative cases
 *   - divc(a, b) → ceilDiv(a, b)  (ceiling division for protocol fees)
 *
 * Source contracts (StonFi V2):
 *   contracts/pool/pools/weighted_stableswap/math.fc   — _invariant, solve_dy, solve_dx (Newton solvers)
 *   contracts/pool/pools/weighted_stableswap/pool.fc   — pool::get_swap_out (fee logic: LP on input, protocol on output)
 *   contracts/pool/msgs/router.fc                      — side convention: side=true → token0→token1
 *
 * Source library (@ston-fi/funcbox 0.1.9, npm):
 *   contracts/math/math.fc   — constants (ONE_18, lookup tables a0–a11 / x0–x11 for ln/exp)
 *   contracts/math/fp/fp.fc  — fpMul, fpDiv, fpLn, fpExp, fpPow, owPow, fpComplement
 *
 * Verified: all outputs match the StonFi /v1/swap/simulate REST API exactly
 * (zero tolerance).
 */

// ── Fixed-point constants (1e18 scale) ──────────────────────────────────────

const ONE    = 10n ** 18n;
const ONE_20 = 10n ** 20n;
const ONE_36 = 10n ** 36n;

const MAX_NAT_EXP =  130n * ONE;
const MIN_NAT_EXP = -41n * ONE;

const LN36_LO = ONE - 10n ** 17n;
const LN36_HI = ONE + 10n ** 17n;

const MILD_EXP_BOUND = (1n << 254n) / ONE_20;

// Lookup table for ln/exp decomposition (Balancer V2 LogExpMath)
const x0 = 128000000000000000000n;  const a0 = 38877084059945950922200000000000000000000000000000000000n;
const x1 =  64000000000000000000n;  const a1 = 6235149080811616882910000000n;
const x2 = 3200000000000000000000n; const a2 = 7896296018268069516100000000000000n;
const x3 = 1600000000000000000000n; const a3 = 888611052050787263676000000n;
const x4 =  800000000000000000000n; const a4 = 298095798704172827474000n;
const x5 =  400000000000000000000n; const a5 = 5459815003314423907810n;
const x6 =  200000000000000000000n; const a6 = 738905609893065022723n;
const x7 =  100000000000000000000n; const a7 = 271828182845904523536n;
const x8 =   50000000000000000000n; const a8 = 164872127070012814685n;
const x9 =   25000000000000000000n; const a9 = 128402541668774148407n;
const x10 =  12500000000000000000n; const a10 = 113314845306682631683n;
const x11 =   6250000000000000000n; const a11 = 106449445891785942956n;

const E_CONST = 2718281828459045235n;
const MAX_POW_REL_ERR = 10000n;  // 10^(-14)

const EPSILON = 1000000000000000000000000n; // 1e24 — Newton convergence threshold
const MAX_ITER = 255;

// ── Arithmetic helpers ──────────────────────────────────────────────────────
// FunC `/` is floor division; JS BigInt `/` truncates toward zero.

function fdiv(a, b) {
    const d = a / b;
    if ((a < 0n) !== (b < 0n) && d * b !== a) return d - 1n;
    return d;
}

function muldiv(a, b, c) { return fdiv(a * b, c); }

function divc(a, b) {
    if (a === 0n) return 0n;
    return (a * b > 0n) ? (a + b - (b > 0n ? 1n : -1n)) / b + (0n) : a / b;
    // Simplified: for positive a, b (our use case):
}

// Actually, FunC divc(a,b) for positive a,b = ceil(a/b) = (a + b - 1) / b
function ceilDiv(a, b) { return (a + b - 1n) / b; }

function abs(x) { return x < 0n ? -x : x; }

// ── Fixed-point primitives (1e18) ───────────────────────────────────────────

function fpMul(a, b)       { return muldiv(a, b, ONE); }
function fpDiv(a, b)       { return muldiv(a, ONE, b); }
function fpFrom(x)         { return x * ONE; }
function fpTo(x)           { return fdiv(x, ONE); }
function fpComplement(x)   { return ONE - x; }

// ── ln (port of funcbox fp.fc) ──────────────────────────────────────────────

function _ln36(x) {
    x = x * ONE;  // scale to 1e36
    const z = muldiv(x - ONE_36, ONE_36, x + ONE_36);
    const z2 = muldiv(z, z, ONE_36);
    let num = z, sum = num;
    num = muldiv(num, z2, ONE_36); sum += fdiv(num, 3n);
    num = muldiv(num, z2, ONE_36); sum += fdiv(num, 5n);
    num = muldiv(num, z2, ONE_36); sum += fdiv(num, 7n);
    num = muldiv(num, z2, ONE_36); sum += fdiv(num, 9n);
    num = muldiv(num, z2, ONE_36); sum += fdiv(num, 11n);
    num = muldiv(num, z2, ONE_36); sum += fdiv(num, 13n);
    num = muldiv(num, z2, ONE_36); sum += fdiv(num, 15n);
    return sum * 2n;
}

function _ln(a) {
    const neg = a < ONE;
    if (neg) a = muldiv(ONE, ONE, a);

    let sum = 0n;
    if (a >= a0 * ONE) { a = fdiv(a, a0); sum += x0; }
    if (a >= a1 * ONE) { a = fdiv(a, a1); sum += x1; }

    sum *= 100n;
    a *= 100n;

    if (a >= a2)  { a = muldiv(a, ONE_20, a2);  sum += x2; }
    if (a >= a3)  { a = muldiv(a, ONE_20, a3);  sum += x3; }
    if (a >= a4)  { a = muldiv(a, ONE_20, a4);  sum += x4; }
    if (a >= a5)  { a = muldiv(a, ONE_20, a5);  sum += x5; }
    if (a >= a6)  { a = muldiv(a, ONE_20, a6);  sum += x6; }
    if (a >= a7)  { a = muldiv(a, ONE_20, a7);  sum += x7; }
    if (a >= a8)  { a = muldiv(a, ONE_20, a8);  sum += x8; }
    if (a >= a9)  { a = muldiv(a, ONE_20, a9);  sum += x9; }
    if (a >= a10) { a = muldiv(a, ONE_20, a10); sum += x10; }
    if (a >= a11) { a = muldiv(a, ONE_20, a11); sum += x11; }

    const z = muldiv(a - ONE_20, ONE_20, a + ONE_20);
    const z2 = muldiv(z, z, ONE_20);
    let num = z, series = num;
    num = muldiv(num, z2, ONE_20); series += fdiv(num, 3n);
    num = muldiv(num, z2, ONE_20); series += fdiv(num, 5n);
    num = muldiv(num, z2, ONE_20); series += fdiv(num, 7n);
    num = muldiv(num, z2, ONE_20); series += fdiv(num, 9n);
    num = muldiv(num, z2, ONE_20); series += fdiv(num, 11n);
    series *= 2n;

    const result = fdiv(sum + series, 100n);
    return neg ? -result : result;
}

function fpLn(a) {
    if (a === E_CONST) return ONE;
    if (a === ONE) return 0n;
    if (a <= 0n) throw new Error("fpLn: input must be positive");
    if (LN36_LO < a && a < LN36_HI) return fdiv(_ln36(a), ONE);
    return _ln(a);
}

// ── exp (port of funcbox fp.fc) ─────────────────────────────────────────────

function fpExp(x) {
    if (x === ONE) return E_CONST;
    if (x < MIN_NAT_EXP || x > MAX_NAT_EXP) throw new Error("fpExp: exponent out of bounds");

    const neg = x < 0n;
    if (neg) {
        x = -x;
        if (x === ONE) return muldiv(ONE, ONE, E_CONST);
        if (x < MIN_NAT_EXP || x > MAX_NAT_EXP) throw new Error("fpExp: exponent out of bounds (neg)");
    }

    let firstAN;
    if      (x >= x0) { x -= x0; firstAN = a0; }
    else if (x >= x1) { x -= x1; firstAN = a1; }
    else               firstAN = 1n;

    x *= 100n;

    let prod = ONE_20;
    if (x >= x2) { x -= x2; prod = muldiv(prod, a2, ONE_20); }
    if (x >= x3) { x -= x3; prod = muldiv(prod, a3, ONE_20); }
    if (x >= x4) { x -= x4; prod = muldiv(prod, a4, ONE_20); }
    if (x >= x5) { x -= x5; prod = muldiv(prod, a5, ONE_20); }
    if (x >= x6) { x -= x6; prod = muldiv(prod, a6, ONE_20); }
    if (x >= x7) { x -= x7; prod = muldiv(prod, a7, ONE_20); }
    if (x >= x8) { x -= x8; prod = muldiv(prod, a8, ONE_20); }
    if (x >= x9) { x -= x9; prod = muldiv(prod, a9, ONE_20); }

    let sum = ONE_20, term = x;
    sum += term;
    for (let i = 2n; i <= 12n; i++) {
        term = muldiv(term, x, ONE_20 * i);
        sum += term;
    }

    const r = muldiv(muldiv(prod, sum, ONE_20), firstAN, 100n);
    return neg ? muldiv(ONE, ONE, r) : r;
}

// ── pow / ow_pow (port of funcbox fp.fc) ────────────────────────────────────

function fpPow(x, y) {
    if (y === 0n) return ONE;
    if (x === 0n) return 0n;
    if (x === ONE) return ONE;
    if ((x >> 256n) !== 0n) throw new Error("fpPow: x out of bounds");
    if (y >= MILD_EXP_BOUND) throw new Error("fpPow: y out of bounds");

    let logxTimesY;
    if (LN36_LO < x && x < LN36_HI) {
        const ln36x = _ln36(x);
        logxTimesY = fdiv(ln36x, ONE) * y + muldiv(ln36x % ONE, y, ONE);
    } else {
        logxTimesY = _ln(x) * y;
    }
    logxTimesY = fdiv(logxTimesY, ONE);

    if (logxTimesY < MIN_NAT_EXP || logxTimesY > MAX_NAT_EXP) {
        throw new Error("fpPow: result out of bounds");
    }
    return fpExp(logxTimesY);
}

function owPow(x, y) {
    // Optimized for common weights: 50/50 and 80/20
    if (y === 2n * ONE) return fpMul(x, x);
    if (y === 4n * ONE) { const sq = fpMul(x, x); return fpMul(sq, sq); }
    const raw = fpPow(x, y);
    const maxErr = fpMul(raw, MAX_POW_REL_ERR) + 1n;
    return raw < maxErr ? 0n : raw - maxErr;
}

// ── Weighted stableswap invariant + Newton solver ───────────────────────────
// Port of weighted_stableswap/math.fc
//
//   invariant k = (x + rate·y)·amp + x^p · (rate·y)^q
//   where p = w0, q = 1 - w0
//
// solve_dy: given reserves (x, y) and input dx added to x, find output dy from y.
// solve_dx: given reserves (x, y) and input dy added to y, find output dx from x.

function _invariant(x, y, p, q, amp, rate) {
    const fx = fpFrom(x);
    const fy = fpFrom(y);
    const ry = fpMul(rate, fy);
    const p1 = fpMul(fx + ry, amp);
    const p2 = fpMul(owPow(fx, p), owPow(ry, q));
    return p1 + p2;
}

function _dyInvariant(x, y, p, q, amp, rate) {
    const fx = fpFrom(x);
    const fy = fpFrom(y);
    // ∂k/∂y = amp·rate + q · y^(q-1) · rate^q · x^p
    const p2_0 = fpMul(q, owPow(fy, q - ONE));
    const p2_1 = fpMul(p2_0, owPow(rate, q));
    return fpMul(amp, rate) + fpMul(p2_1, owPow(fx, p));
}

function _dxInvariant(x, y, p, q, amp, rate) {
    const fx = fpFrom(x);
    const fy = fpFrom(y);
    // ∂k/∂x = amp + p · x^(p-1) · rate^q · y^q
    const p2_0 = fpMul(p, owPow(fx, p - ONE));
    const p2_1 = fpMul(p2_0, owPow(rate, q));
    const p2_2 = fpMul(p2_1, owPow(fy, q));
    return amp + p2_2;
}

function solveDy(x, y, dx, amp, rate, w0) {
    const p = w0, q = fpComplement(w0);
    let startY = y;
    const k = _invariant(x, y, p, q, amp, rate);
    for (let i = 0; i < MAX_ITER; i++) {
        const deltaF = _invariant(x + dx, startY, p, q, amp, rate) - k;
        const dfD = _dyInvariant(x + dx, startY, p, q, amp, rate);
        if (dfD === 0n) throw new Error("solveDy: zero derivative");
        startY -= fpTo(fpDiv(deltaF, dfD));
        if (abs(deltaF) <= EPSILON) return y - startY;
    }
    throw new Error("solveDy: did not converge");
}

function solveDx(x, y, dy, amp, rate, w0) {
    const p = w0, q = fpComplement(w0);
    let startX = x;
    const k = _invariant(x, y, p, q, amp, rate);
    for (let i = 0; i < MAX_ITER; i++) {
        const deltaF = _invariant(startX, y + dy, p, q, amp, rate) - k;
        const dfD = _dxInvariant(startX, y + dy, p, q, amp, rate);
        if (dfD === 0n) throw new Error("solveDx: zero derivative");
        startX -= fpTo(fpDiv(deltaF, dfD));
        if (abs(deltaF) <= EPSILON) return x - startX;
    }
    throw new Error("solveDx: did not converge");
}

// ── Public: weighted stableswap output calculation ──────────────────────────
// Port of weighted_stableswap/pool.fc :: pool::get_swap_out

/**
 * Calculate swap output for a weighted stableswap pool.
 *
 * @param {bigint} reserve0 — pool reserve for token0 (raw nanotons)
 * @param {bigint} reserve1 — pool reserve for token1 (raw nanotons)
 * @param {bigint} amountIn — input amount (raw)
 * @param {boolean} side — true if offering token0, false if offering token1
 * @param {number} lpFeeBps — LP fee in basis points (applied on input)
 * @param {number} protocolFeeBps — protocol fee in bps (applied on output, ceil)
 * @param {bigint} amp — amplification parameter (1e18 fixed-point)
 * @param {bigint} rate — exchange rate (1e18 fixed-point)
 * @param {bigint} w0 — weight parameter (1e18 fixed-point)
 * @returns {{ amountOut: bigint, feeAmount: bigint }}
 */
export function weightedStableSwap(reserve0, reserve1, amountIn, side, lpFeeBps, protocolFeeBps, amp, rate, w0, referralBps) {
    const FEE_DIV = 10_000n;

    // LP fee on input (floor division, matching FunC muldiv)
    const netIn = amountIn * (FEE_DIV - BigInt(lpFeeBps)) / FEE_DIV;

    // Newton solver for base output
    let baseOut;
    if (side) {
        baseOut = solveDy(reserve0, reserve1, netIn, amp, rate, w0);
    } else {
        baseOut = solveDx(reserve0, reserve1, netIn, amp, rate, w0);
    }

    // Protocol fee on output (ceiling division, matching FunC divc)
    let protocolFeeOut = 0n;
    if (protocolFeeBps > 0) {
        protocolFeeOut = ceilDiv(baseOut * BigInt(protocolFeeBps), FEE_DIV);
    }

    let refFeeOut = 0n;
    if (referralBps > 0) {
        refFeeOut = ceilDiv(baseOut * BigInt(referralBps), FEE_DIV);
    }

    return {
        amountOut:  baseOut - protocolFeeOut - refFeeOut,
        feeAmount:  amountIn * (BigInt(lpFeeBps) + BigInt(protocolFeeBps) + BigInt(referralBps)) / FEE_DIV,
    };
}
