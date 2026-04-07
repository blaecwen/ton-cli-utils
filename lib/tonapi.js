/**
 * lib/tonapi.js — TonAPI HTTP helpers and token metadata resolution
 *
 * Exports:
 *   TONAPI_BASE        — base URL for TonAPI v2
 *   makeHeaders        — Authorization header builder (reads TONAPI_KEY env var)
 *   getJson            — fetch with retry, rate-limit backoff, and timeout
 *   jettonMeta         — resolve { symbol, decimals } for a token address
 *   usdPrice           — fetch USD price for a token via TonAPI /rates
 *   fetchEvent         — fetch a semantic event by transaction hash
 *   fetchTradeEvent    — find wallet's latest trade tx + poll for completed event
 *   parseSwapAmounts   — extract normalised swap records from a TonAPI event
 */

import fetch from "node-fetch";
import { tokenByAddress, TON } from "./tokens.js";
import { toEQ } from "./addr.js";
import { info, warn } from "./log.js";

export const TONAPI_BASE    = "https://tonapi.io/v2";

export function makeHeaders() {
    const key = process.env.TONAPI_KEY;
    return key ? { Authorization: `Bearer ${key}` } : {};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Sliding window rate limiter ───────────────────────────────────────────────
// Every API call passes through acquireToken().
// TonAPI allows 10 requests per 10s sliding window. We track the timestamps of
// recent requests and only proceed when there's room in the window. This uses
// the full budget — no artificial smoothing, no wasted capacity.
//
// Supports "high" and "normal" priority. High-priority callers get slots first.

const WINDOW_MS = 10_000;
const WINDOW_MAX = 10;
const _reqTimes = []; // timestamps of requests inside the current window
let _highWaiting = 0; // count of high-priority callers inside acquireToken

async function acquireToken(priority = "normal") {
    if (priority === "high") _highWaiting++;
    try {
        while (true) {
            const now = Date.now();
            // Evict requests that have fallen out of the window
            while (_reqTimes.length && _reqTimes[0] <= now - WINDOW_MS) {
                _reqTimes.shift();
            }
            if (_reqTimes.length < WINDOW_MAX) {
                // Slot available — but normal callers yield to waiting high callers
                if (priority !== "high" && _highWaiting > 0) {
                    await sleep(50);
                    continue;
                }
                _reqTimes.push(now);
                return;
            }
            // Wait until the oldest request exits the window
            const waitMs = _reqTimes[0] + WINDOW_MS - now + 50; // +50ms safety margin
            if (priority === "high") {
                warn("api", `rate limiter: high-priority caller blocked for ~${waitMs}ms (${_reqTimes.length}/${WINDOW_MAX} slots used)`);
            }
            await sleep(waitMs);
        }
    } finally {
        if (priority === "high") _highWaiting--;
    }
}

/** HTTP fetch with retry and rate-limit backoff. */
export async function getJson(url, params = {}, { retries = 3, silent = false, label = "", priority = "normal" } = {}) {
    const qs   = new URLSearchParams(params).toString();
    const full = qs ? `${url}?${qs}` : url;
    const tag  = label ? ` [${label}]` : "";

    for (let attempt = 0; attempt <= retries; attempt++) {
        await acquireToken(priority);
        try {
            const res = await fetch(full, {
                headers: makeHeaders(),
                signal:  AbortSignal.timeout(15_000),
            });
            if (res.ok) return res.json();

            if (res.status === 429 || res.status >= 500) {
                const wait = 1000 * 2 ** attempt; // 1s, 2s, 4s, 8s
                const reason = res.status === 429 ? "rate limited" : `server error ${res.status}`;
                const log = res.status === 429 && priority !== "high" ? info : warn;
                if (!silent) log("api", `${tag ? tag + " " : ""}HTTP ${res.status} — ${reason}, retrying in ${wait / 1000}s…`);
                await sleep(wait);
                continue;
            }

            if (!silent) warn("api", `${tag ? tag + " " : ""}HTTP ${res.status}  ${full}`);
            return null;
        } catch (e) {
            if (attempt < retries) {
                await sleep(500 * (attempt + 1));
                continue;
            }
            if (!silent) warn("api", `${tag ? tag + " " : ""}${url}: ${e.message}`);
        }
    }
    return null;
}

export async function jettonMeta(addr) {
    const known = tokenByAddress(addr);
    if (known) return known;
    const data = await getJson(`${TONAPI_BASE}/jettons/${addr}`);
    const meta = data?.metadata || {};
    return {
        symbol:   meta.symbol   || addr.slice(0, 8) + "…",
        decimals: parseInt(meta.decimals || 9),
    };
}

export async function usdPrice(addr) {
    const token = addr === "TON" ? "TON" : addr;
    const data  = await getJson(`${TONAPI_BASE}/rates`, { tokens: token, currencies: "usd" });
    const entry = data?.rates?.[token];
    return entry?.prices?.USD ? parseFloat(entry.prices.USD) : null;
}



/**
 * Fetch a TonAPI event by transaction hash.
 * Returns a stitched semantic event (JettonSwap, JettonTransfer, etc.)
 * covering the full message chain that the tx belongs to.
 */
export async function fetchEvent(txHash) {
    return getJson(`${TONAPI_BASE}/events/${txHash}`, {}, { silent: true });
}

/**
 * Fetch the most recent outbound transaction for a wallet, then fetch its
 * semantic event (with in_progress polling). Returns { ourTxHash, event }
 * or { error } if anything fails.
 *
 * @param {string} walletAddr — non-bounceable address string
 * @param {object} [opts]
 * @param {number} [opts.afterUtime] — ignore txs before this unix timestamp (seconds)
 * @param {number} [opts.txRetries=4] — retries for finding the outbound tx (indexer lag)
 * @param {number} [opts.txRetryMs=3000] — delay between tx lookup retries
 * @param {number} [opts.eventRetries=5] — max in_progress polls
 * @param {number} [opts.eventRetryMs=3000] — delay between polls
 * @param {number} [opts.initialDelayMs=3000] — wait for indexing before first fetch
 */
export async function fetchTradeEvent(walletAddr, opts = {}) {
    const {
        afterUtime = 0,
        txRetries = 4,
        txRetryMs = 3_000,
        eventRetries = 5,
        eventRetryMs = 3_000,
        initialDelayMs = 3_000,
    } = opts;

    if (initialDelayMs > 0) await sleep(initialDelayMs);

    // Step 1: find outbound tx (retry — indexer may lag behind chain)
    let ourTx = null;
    for (let i = 0; i <= txRetries; i++) {
        const res = await getJson(
            `${TONAPI_BASE}/blockchain/accounts/${walletAddr}/transactions`,
            { limit: 5 }, { label: "verify-tx" },
        );
        ourTx = (res?.transactions || []).find(tx =>
            tx.out_msgs?.length > 0 && tx.utime >= afterUtime
        );
        if (ourTx) break;
        if (i < txRetries) await sleep(txRetryMs);
    }
    if (!ourTx) return { error: "could not find outbound transaction" };

    const ourTxHash = ourTx.hash;

    // Step 2: fetch event, poll if in_progress
    let event = null;
    for (let i = 0; i < eventRetries; i++) {
        event = await fetchEvent(ourTxHash);
        if (event && !event.in_progress) break;
        event = null;
        if (i < eventRetries - 1) await sleep(eventRetryMs);
    }

    if (!event) return { ourTxHash, error: "event not available or still in_progress after retries" };

    return { ourTxHash, event };
}

/**
 * Parse JettonSwap actions from a TonAPI event into normalised swap records.
 * Each record: { inAddr, amountIn, amountOut, status }.
 *
 * Handles TON-native legs (ton_in / ton_out) and normalises raw "0:hex"
 * addresses to EQ format for easy comparison against our token addresses.
 *
 * Used by swap.js for sim vs actual comparison after trade execution.
 */
export function parseSwapAmounts(event) {
    const swaps = [];
    for (const action of (event.actions || [])) {
        if (action.type !== "JettonSwap") continue;
        const js = action.JettonSwap || action.jetton_swap;
        if (!js) continue;

        const hasTonIn  = js.ton_in != null && js.ton_in > 0;
        const hasTonOut = js.ton_out != null && js.ton_out > 0;
        const rawInAddr = hasTonIn ? TON : js.jetton_master_in?.address;
        const inAddr    = rawInAddr && rawInAddr !== TON ? toEQ(rawInAddr) : rawInAddr;

        const amountIn  = hasTonIn  ? BigInt(js.ton_in)  : BigInt(js.amount_in || 0);
        const amountOut = hasTonOut ? BigInt(js.ton_out) : BigInt(js.amount_out || 0);

        swaps.push({ inAddr, amountIn, amountOut, status: action.status });
    }
    return swaps;
}
