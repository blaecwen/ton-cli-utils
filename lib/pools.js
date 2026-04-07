/**
 * lib/pools.js — Pool detection, AMM math, and on-chain reserve fetchers
 *
 * Exports:
 *   STONFI_IFACES / DEDUST_IFACES  — interface name sets for type detection
 *   poolInterfaces / classifyPool  — TonAPI-based pool type detection
 *   fetchStonfiPool / fetchDedustPool   — REST-based pool state fetchers
 *   warmupPoolMeta           — startup: resolve tokens, fees, wallet→master (call before POOL_ADAPTERS)
 *   POOL_ADAPTERS            — on-chain adapters: exactly 1 API call each
 *   simulateSwapOnPool       — simulate a swap on a pool state
 *   cpamm / cpammSplit / swapCalc — AMM math
 */

import { Cell, Address } from "@ton/ton";
import { TONAPI_BASE, getJson } from "./tonapi.js";
import { TON, normTon, PTON_ADDRS } from "./tokens.js";
import { toEQ } from "./addr.js";
import { weightedStableSwap } from "./stableswap.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const STONFI_BASE = "https://api.ston.fi";
export const DEDUST_BASE = "https://api.dedust.io/v2";

export const STONFI_IFACES = new Set(["stonfi_pool", "stonfi_pool_v2_const_product", "stonfi_pool_v2_stable", "stonfi_pool_v2_stableswap", "stonfi_pool_v2_weighted_stableswap"]);
export const DEDUST_IFACES = new Set(["dedust_pool", "dedust_pool_v2"]);

// ── Pool detection ────────────────────────────────────────────────────────────

export async function poolInterfaces(addr) {
    const data = await getJson(`${TONAPI_BASE}/accounts/${addr}`);
    return new Set((data?.interfaces) || []);
}

export function classifyPool(ifaces) {
    for (const i of ifaces) if (STONFI_IFACES.has(i)) return { type: "stonfi", version: i === "stonfi_pool" ? "v1" : "v2" };
    for (const i of ifaces) if (DEDUST_IFACES.has(i)) return { type: "dedust" };
    return { type: "unknown" };
}

// ── AMM math ──────────────────────────────────────────────────────────────────

/** Generic CPAMM: single combined fee applied on input. Used for DeDust / unknown. */
export function cpamm(rIn, rOut, amountIn, feeBps) {
    const dxNet     = BigInt(amountIn) * BigInt(10_000 - feeBps);
    const amountOut = dxNet * BigInt(rOut) / (BigInt(rIn) * 10_000n + dxNet);
    const feeAmount = BigInt(amountIn) * BigInt(feeBps) / 10_000n;
    return { amountOut, feeAmount };
}

/**
 * StonFi CPAMM (v1 + v2): LP fee on input, protocol fee on output (matching the contract).
 * Both v1 and v2 contracts use this split-fee model.
 */
export function cpammSplit(rIn, rOut, amountIn, lpFeeBps, protocolFeeBps, referralBps) {
    const rInBig  = BigInt(rIn);
    const rOutBig = BigInt(rOut);
    const amt     = BigInt(amountIn);
    const lpFee   = BigInt(lpFeeBps);
    const proto   = BigInt(protocolFeeBps);
    const ref     = BigInt(referralBps);

    const amountInWithFee = amt * (10_000n - lpFee);
    let baseOut = amountInWithFee * rOutBig / (rInBig * 10_000n + amountInWithFee);

    let protocolFeeOut = 0n;
    if (proto > 0n) {
        protocolFeeOut = (baseOut * proto + 9_999n) / 10_000n; // ceil div
    }

    let refFeeOut = 0n;
    if (ref > 0n) {
        refFeeOut = (baseOut * ref + 9_999n) / 10_000n; // ceil div, matching contract
    }

    const amountOut = baseOut - protocolFeeOut - refFeeOut;
    const feeAmount = amt * (lpFee + proto + ref) / 10_000n;
    return { amountOut, feeAmount };
}

/**
 * Dispatch to the correct AMM based on pool type.
 * For StonFi stableswap (amp present), uses weighted stableswap Newton solver.
 * For StonFi (v1 + v2 const product), uses split fees (LP on input, protocol on output).
 * For everything else, uses the combined single-fee model.
 *
 * @param {object} [stableParams] — required for stableswap pools:
 *   { reserve0, reserve1, side, amp, rate, w0 }
 */
export function swapCalc(poolType, rIn, rOut, amountIn, feeBps, lpFeeBps, protocolFeeBps, stableParams, referralBps) {
    if (stableParams?.amp != null) {
        return weightedStableSwap(
            stableParams.reserve0, stableParams.reserve1, amountIn,
            stableParams.side, lpFeeBps, protocolFeeBps,
            stableParams.amp, stableParams.rate, stableParams.w0,
            referralBps,
        );
    }
    if (poolType?.startsWith("stonfi") && lpFeeBps != null && protocolFeeBps != null) {
        return cpammSplit(rIn, rOut, amountIn, lpFeeBps, protocolFeeBps, referralBps);
    }
    return cpamm(rIn, rOut, amountIn, feeBps);
}

// ── Pool data fetchers ────────────────────────────────────────────────────────

/**
 * Fetch live pool state from StonFi.
 * Returns { token0, token1, reserve0, reserve1, feeBps } or null.
 */
export async function fetchStonfiPool(poolAddr, label = "") {
    const data = await getJson(`${STONFI_BASE}/v1/pools/${poolAddr}`, {}, { label: label || `stonfi-rest ${poolAddr.slice(0, 8)}…` });
    if (!data) return null;
    const pool = data.pool || data;
    const lpFeeBps       = parseInt(pool.lp_fee || 0);
    const protocolFeeBps = parseInt(pool.protocol_fee || 0);
    return {
        token0:   normTon(pool.token0_address || ""),
        token1:   normTon(pool.token1_address || ""),
        reserve0: BigInt(pool.reserve0 || 0),
        reserve1: BigInt(pool.reserve1 || 0),
        feeBps:   (lpFeeBps + protocolFeeBps) || 30,
        lpFeeBps,
        protocolFeeBps,
    };
}

/**
 * Fetch live pool state from DeDust.
 * Returns { token0, token1, reserve0, reserve1, feeBps } or null.
 *
 * The /pools endpoint returns all pools, so we cache the response briefly
 * to avoid redundant fetches when multiple DeDust pools are queried in quick succession.
 */
let _dedustPoolsCache = null; // { promise, ts }
const DEDUST_CACHE_TTL = 5_000; // 5s cache

async function fetchDedustPoolsList() {
    const now = Date.now();
    if (_dedustPoolsCache && now - _dedustPoolsCache.ts < DEDUST_CACHE_TTL) {
        return _dedustPoolsCache.promise;
    }
    const promise = getJson(`${DEDUST_BASE}/pools`, {}, { label: "dedust-rest pools" });
    _dedustPoolsCache = { promise, ts: now };
    // Clear cache on failure so next caller retries
    promise.catch(() => { if (_dedustPoolsCache?.promise === promise) _dedustPoolsCache = null; });
    return promise;
}

export async function fetchDedustPool(poolAddr) {
    const pools = await fetchDedustPoolsList();
    if (!Array.isArray(pools)) return null;
    const pool = pools.find(p => p.address === poolAddr);
    if (!pool) return null;

    const assets   = pool.assets   || [];
    const reserves = pool.reserves || [];
    if (assets.length < 2 || reserves.length < 2) return null;

    const assetAddr = (a) => a.type === "native" ? TON : a.address;
    const fees = pool.fees || {};
    return {
        token0:   assetAddr(assets[0]),
        token1:   assetAddr(assets[1]),
        reserve0: BigInt(reserves[0]),
        reserve1: BigInt(reserves[1]),
        feeBps:   fees.poolFee != null ? parseInt(fees.poolFee) : fees.tradeFee != null ? parseInt(fees.tradeFee) : null,
    };
}

/**
 * Simulate a swap on a pool given its state directly (no API call).
 * poolState: { token0, token1, reserve0, reserve1, feeBps }
 *
 * Returns { askAddr, amountOut, feeAmount, feeBps, priceImpact } or null.
 */
export function simulateSwapOnPool(poolState, offerAddr, amountNano, referralBps) {
    const { token0, token1, reserve0, reserve1, feeBps, poolType, lpFeeBps, protocolFeeBps, amp, rate, w0 } = poolState;

    let rIn, rOut, askAddr;
    if      (offerAddr === token0) { rIn = reserve0; rOut = reserve1; askAddr = token1; }
    else if (offerAddr === token1) { rIn = reserve1; rOut = reserve0; askAddr = token0; }
    else return null;

    if (rIn === 0n || rOut === 0n) return null;

    // Only apply referral fee on StonFi pools (DeDust handles referral at protocol level)
    const refBps = poolType?.startsWith("stonfi") ? referralBps : 0;
    const stableParams = amp != null ? { reserve0, reserve1, side: offerAddr === token0, amp, rate, w0 } : undefined;
    const { amountOut, feeAmount } = swapCalc(poolType, rIn, rOut, amountNano, feeBps, lpFeeBps, protocolFeeBps, stableParams, refBps);
    return {
        askAddr,
        amountOut,
        feeAmount,
        feeBps,
        priceImpact: Number(amountNano) / (Number(rIn) + Number(amountNano)),
    };
}


// ── On-chain helpers ─────────────────────────────────────────────────────────

function parseAddressCell(item) {
    if (item?.type !== "cell") throw new Error(`Expected cell, got type=${item?.type}`);
    const cell  = Cell.fromBoc(Buffer.from(item.cell, "hex"))[0];
    const slice = cell.beginParse();
    const addr  = slice.loadAddress();
    return normTon(addr.toString({ bounceable: true, urlSafe: true }));
}

function parseStackNum(item) {
    if (item?.type !== "num") throw new Error(`Expected num, got type=${item?.type}`);
    const raw = item.num;
    const neg = raw.startsWith("-");
    const abs = raw.replace(/^-/, "");
    const val = BigInt(abs.startsWith("0x") ? abs : `0x${abs}`);
    return neg ? -val : val;
}

/** Single TonAPI call to run an on-chain get-method. */
async function runGetMethod(addr, method, label = "", priority = "normal") {
    const data = await getJson(`${TONAPI_BASE}/blockchain/accounts/${addr}/methods/${method}`, {}, { label, priority });
    if (!data?.stack) throw new Error(`No stack returned for ${method} on ${addr}`);
    return data;
}

async function resolveJettonMaster(walletAddr) {
    const { decoded, stack } = await runGetMethod(walletAddr, "get_wallet_data", `resolve-master ${walletAddr.slice(0, 8)}…`);
    if (decoded?.jetton) return normAddr(decoded.jetton);
    if (decoded?.jetton_master_address) return normAddr(decoded.jetton_master_address);
    return parseAddressCell(stack[2]);
}

// Normalise a raw address string (0:hex or EQ/UQ) to bounceable urlsafe form,
// then apply normTon so pTON addresses become the "TON" sentinel.
function normAddr(raw) {
    if (!raw) return null;
    return normTon(toEQ(raw) ?? raw);
}

function parseStonfiV1Stack(decoded, stack) {
    if (decoded) {
        const lpFeeBps       = decoded.lp_fee ?? 0;
        const protocolFeeBps = decoded.protocol_fee ?? 0;
        return {
            reserve0: BigInt(decoded.reserve0),
            reserve1: BigInt(decoded.reserve1),
            token0:   normAddr(decoded.token0_address),
            token1:   normAddr(decoded.token1_address),
            feeBps:   lpFeeBps + protocolFeeBps,
            lpFeeBps,
            protocolFeeBps,
        };
    }
    const lpFeeBps       = Number(parseStackNum(stack[4]));
    const protocolFeeBps = Number(parseStackNum(stack[5]));
    return {
        reserve0: parseStackNum(stack[0]),
        reserve1: parseStackNum(stack[1]),
        token0:   parseAddressCell(stack[2]),
        token1:   parseAddressCell(stack[3]),
        feeBps:   lpFeeBps + protocolFeeBps,
        lpFeeBps,
        protocolFeeBps,
    };
}

function parseStonfiV2Stack(decoded, stack) {
    const base = decoded ? {
        lpFeeBps:       decoded.lp_fee ?? 0,
        protocolFeeBps: decoded.protocol_fee ?? 0,
        reserve0:       BigInt(decoded.reserve0),
        reserve1:       BigInt(decoded.reserve1),
        token0Wallet:   normAddr(decoded.token0_wallet_address),
        token1Wallet:   normAddr(decoded.token1_wallet_address),
    } : {
        lpFeeBps:       Number(parseStackNum(stack[7])),
        protocolFeeBps: Number(parseStackNum(stack[8])),
        reserve0:       parseStackNum(stack[3]),
        reserve1:       parseStackNum(stack[4]),
        token0Wallet:   parseAddressCell(stack[5]),
        token1Wallet:   parseAddressCell(stack[6]),
    };
    // Router address (needed for stableswap pools which use a different router)
    if (decoded?.router_address) {
        base.routerAddress = normAddr(decoded.router_address);
    } else if (stack && stack.length > 1) {
        try { base.routerAddress = parseAddressCell(stack[1]); } catch {}
    }
    // Stableswap pools have extra parameters (amp, rate, w0) after the base fields
    if (decoded?.amp != null) {
        base.amp  = BigInt(decoded.amp);
        base.rate = decoded.rate != null ? BigInt(decoded.rate) : null;
        base.w0   = decoded.w0 != null ? BigInt(decoded.w0) : null;
    } else if (stack && stack.length > 12) {
        base.amp  = parseStackNum(stack[12]);
        base.rate = stack.length > 13 ? parseStackNum(stack[13]) : null;
        base.w0   = stack.length > 14 ? parseStackNum(stack[14]) : null;
    }
    return base;
}

function parseDedustReserves(decoded, stack) {
    if (decoded) {
        return { reserve0: BigInt(decoded.reserve0), reserve1: BigInt(decoded.reserve1) };
    }
    return { reserve0: parseStackNum(stack[0]), reserve1: parseStackNum(stack[1]) };
}

function parseDedustFee(feeData) {
    if (!feeData) return null;
    if (feeData.decoded?.trade_fee_numerator != null && feeData.decoded?.trade_fee_denominator != null) {
        const num = Number(feeData.decoded.trade_fee_numerator);
        const den = Number(feeData.decoded.trade_fee_denominator);
        if (den > 0) return Math.round(num / den * 10_000);
    } else if (feeData.stack?.length >= 2) {
        const num = Number(parseStackNum(feeData.stack[0]));
        const den = Number(parseStackNum(feeData.stack[1]));
        if (den > 0) return Math.round(num / den * 10_000);
    }
    return null;
}

function parseDedustAsset(item) {
    if (item?.type !== "cell") throw new Error(`Expected cell for asset, got type=${item?.type}`);
    const cell  = Cell.fromBoc(Buffer.from(item.cell, "hex"))[0];
    const slice = cell.beginParse();
    const tag   = slice.loadUint(4);
    if (tag === 0) return TON; // native
    // tag 1 = jetton: workchain (8 bits) + hash (256 bits)
    const wc   = slice.loadInt(8);
    const hash = slice.loadUintBig(256);
    const hex  = hash.toString(16).padStart(64, "0");
    const raw  = `${wc}:${hex}`;
    return normTon(Address.parseRaw(raw).toString({ bounceable: true, urlSafe: true }));
}

function parseDedustAssets(assetData) {
    if (!assetData) return {};
    if (assetData.decoded?.asset0_address != null) {
        return {
            token0: normAddr(assetData.decoded.asset0_address),
            token1: normAddr(assetData.decoded.asset1_address),
        };
    }
    if (assetData.stack?.length >= 2) {
        return {
            token0: parseDedustAsset(assetData.stack[0]),
            token1: parseDedustAsset(assetData.stack[1]),
        };
    }
    return {};
}

// ── Pool warmup (startup only — resolves tokens, fees, masters) ─────────────
//
// Must be called once per pool before fetching reserves.
// Populates the pool object with stable metadata so reserve fetchers
// never needs to resolve it.

const _warmupDone = new Set(); // poolAddrs that have been warmed up

/**
 * Warmup all pools: resolve tokens, fees, wallet→master mappings.
 * Call once at startup before fetching reserves or simulating swaps.
 * Populates pool.{token0, token1, liveFeeBps, lpFeeBps, protocolFeeBps}
 * and for StonFi v2 also pool.{token0Wallet, token1Wallet}.
 */
export async function warmupPoolMeta(pools) {
    await Promise.all(pools.map(async (pool) => {
        const addr = pool.address;
        if (_warmupDone.has(addr)) return;
        const label = `warmup ${pool.pair} ${addr.slice(0, 8)}…`;

        if (pool.poolType === "stonfi_v1") {
            const { decoded, stack } = await runGetMethod(addr, "get_pool_data", label);
            const r = parseStonfiV1Stack(decoded, stack);
            pool.lpFeeBps       = r.lpFeeBps;
            pool.protocolFeeBps = r.protocolFeeBps;
            pool.liveFeeBps     = r.feeBps;
            // V1 get_pool_data returns the pool's jetton wallet addresses, not masters.
            // Resolve wallet → master so downstream code (warmupStonfi) can use them correctly.
            if (!pool.token0 || !pool.token1) {
                const [token0, token1] = await Promise.all([
                    pool.token0 ? null : resolveJettonMaster(r.token0),
                    pool.token1 ? null : resolveJettonMaster(r.token1),
                ]);
                pool.token0 = pool.token0 ?? token0;
                pool.token1 = pool.token1 ?? token1;
            }

        } else if (pool.poolType === "stonfi_v2") {
            const { decoded, stack } = await runGetMethod(addr, "get_pool_data", label);
            const r = parseStonfiV2Stack(decoded, stack);
            pool.lpFeeBps       = r.lpFeeBps;
            pool.protocolFeeBps = r.protocolFeeBps;
            pool.liveFeeBps     = r.lpFeeBps + r.protocolFeeBps;
            pool.token0Wallet   = r.token0Wallet;
            pool.token1Wallet   = r.token1Wallet;
            // Stableswap parameters (null for constant-product pools)
            if (r.amp != null) { pool.amp = r.amp; pool.rate = r.rate; pool.w0 = r.w0; }
            if (r.routerAddress) pool.routerAddress = r.routerAddress;
            // Resolve wallet → master (immutable on-chain, only done here)
            const [token0, token1] = await Promise.all([
                resolveJettonMaster(r.token0Wallet),
                resolveJettonMaster(r.token1Wallet),
            ]);
            pool.token0 = pool.token0 ?? token0;
            pool.token1 = pool.token1 ?? token1;

        } else if (pool.poolType === "dedust") {
            const [feeData, assetData] = await Promise.all([
                runGetMethod(addr, "get_trade_fee", label).catch(() => null),
                runGetMethod(addr, "get_assets", label).catch(() => null),
            ]);
            const feeBps = parseDedustFee(feeData);
            if (feeBps != null) pool.liveFeeBps = feeBps;
            const assets = parseDedustAssets(assetData);
            pool.token0 = pool.token0 ?? assets.token0;
            pool.token1 = pool.token1 ?? assets.token1;
        }

        _warmupDone.add(addr);
    }));
}


// ── On-chain reserve fetchers ────────────────────────────────────────────────
//
// These functions fetch live reserves. They MUST:
//   • Make exactly ONE API call (runGetMethod for reserves)
//   • Do zero token resolution, zero fee fetches
//   • Contain no conditional "first call" logic
//
// All metadata (tokens, fees, wallet→master) is resolved during warmup.
// If warmup was not called, these will still work but return partial data
// (no tokens for DeDust, no master addrs for StonFi v2).

/**
 * StonFi V1 — 1 API call: get_pool_data.
 * Returns reserves + fees (both embedded in the same response, no extra cost).
 */
export async function fetchStonfiV1PoolOnChain(poolAddr, label = "", priority = "normal") {
    const { decoded, stack } = await runGetMethod(poolAddr, "get_pool_data", label, priority);
    const r = parseStonfiV1Stack(decoded, stack);
    // V1 get_pool_data returns the pool's jetton wallet addresses, not masters.
    // Expose them as token0Wallet/token1Wallet (like V2) so they don't clobber
    // the resolved master addresses set during warmup.
    return {
        reserve0: r.reserve0, reserve1: r.reserve1,
        token0Wallet: r.token0, token1Wallet: r.token1,
        feeBps: r.feeBps, lpFeeBps: r.lpFeeBps, protocolFeeBps: r.protocolFeeBps,
    };
}

/**
 * StonFi V2 — 1 API call: get_pool_data.
 * Reserves + fees from the response. Token masters resolved at warmup.
 */
export async function fetchStonfiV2PoolOnChain(poolAddr, label = "", priority = "normal") {
    const { decoded, stack } = await runGetMethod(poolAddr, "get_pool_data", label, priority);
    const r = parseStonfiV2Stack(decoded, stack);
    const state = {
        reserve0: r.reserve0, reserve1: r.reserve1,
        token0Wallet: r.token0Wallet, token1Wallet: r.token1Wallet,
        feeBps: r.lpFeeBps + r.protocolFeeBps, lpFeeBps: r.lpFeeBps, protocolFeeBps: r.protocolFeeBps,
    };
    // Stableswap parameters (returned on every fetch since they're in get_pool_data)
    if (r.amp != null) { state.amp = r.amp; state.rate = r.rate; state.w0 = r.w0; }
    return state;
}

/**
 * DeDust — 1 API call: get_reserves.
 * Fees + assets resolved at warmup.
 */
export async function fetchDedustPoolOnChain(poolAddr, label = "", priority = "normal") {
    const { decoded, stack } = await runGetMethod(poolAddr, "get_reserves", label, priority);
    return parseDedustReserves(decoded, stack);
}

// ── Adapter maps ──────────────────────────────────────────────────────────────

/** On-chain reserve adapters — 1 API call each. Require warmupPoolMeta() first. */
export const POOL_ADAPTERS = {
    stonfi_v1: fetchStonfiV1PoolOnChain,
    stonfi_v2: fetchStonfiV2PoolOnChain,
    dedust:    fetchDedustPoolOnChain,
};

export const REST_ADAPTERS = {
    stonfi_v1: fetchStonfiPool,
    stonfi_v2: fetchStonfiPool,
    dedust:    fetchDedustPool,
};

