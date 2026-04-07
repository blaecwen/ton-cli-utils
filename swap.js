#!/usr/bin/env node
/**
 * swap.js — Execute a swap on TON DEX pools (StonFi + DeDust)
 *
 * Run without arguments to see full usage and examples.
 */

import readline from "readline";
import { TONAPI_BASE, getJson, jettonMeta, usdPrice, fetchTradeEvent, parseSwapAmounts } from "./lib/tonapi.js";
import { TON, resolveToken, knownSymbols } from "./lib/tokens.js";
import { poolInterfaces, classifyPool,
         POOL_ADAPTERS, REST_ADAPTERS, warmupPoolMeta, simulateSwapOnPool } from "./lib/pools.js";
import {
    createWallet,
    buildLeg,
    sendLegsWithSeqno,
    waitForSeqno,
    warmupPools,
    poolTypeToInfo,
    SeqnoTracker,
    minAskAmount,
    DEFAULT_SLIPPAGE,
    REFERRAL_VALUE,
} from "./lib/exec.js";
import { resolvePoolAddr, readAddresses } from "./lib/addresses.js";
import { normTon } from "./lib/tokens.js";
import { toRaw } from "./lib/addr.js";
import { error, warn, info } from "./lib/log.js";

// ── Balance check ───────────────────────────────────────────────────────────

async function getBalance(walletAddr, tokenAddr) {
    const addr = walletAddr.toString({ bounceable: false });
    if (tokenAddr === TON) {
        const data = await getJson(`${TONAPI_BASE}/accounts/${addr}`);
        return BigInt(data?.balance ?? "0");
    }
    const data = await getJson(`${TONAPI_BASE}/accounts/${addr}/jettons`);
    const raw = toRaw(tokenAddr);
    const match = (data?.balances ?? []).find(j => j.jetton?.address === raw);
    return BigInt(match?.balance ?? "0");
}

const TON_GAS_RESERVE = 1_000_000_000n; // 1 TON reserved for gas

function checkBalance(balance, amountNano, tokenAddr, symbol, decimals) {
    const available = tokenAddr === TON ? balance - TON_GAS_RESERVE : balance;
    if (available < amountNano) {
        const have = (Number(available > 0n ? available : 0n) / 10 ** decimals).toFixed(Math.min(decimals, 6)).replace(/\.?0+$/, "");
        const need = (Number(amountNano) / 10 ** decimals).toFixed(Math.min(decimals, 6)).replace(/\.?0+$/, "");
        const extra = tokenAddr === TON ? " (1 TON reserved for gas)" : "";
        error(`Insufficient balance: have ${have} ${symbol}${extra}, need ${need} ${symbol}`);
        process.exit(1);
    }
}

// ── Display ──────────────────────────────────────────────────────────────────

const fmtAmt = (nano, sym, dec) =>
    `${(Number(nano) / 10 ** dec).toFixed(Math.min(dec, 6)).replace(/\.?0+$/, "")} ${sym}`;

const fmtUsd = (usd) =>
    usd != null ? `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "n/a";

// ── Confirmation prompt ──────────────────────────────────────────────────────

function confirm(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (ans) => { rl.close(); resolve(ans.trim().toLowerCase() === "y"); });
    });
}

// ── Sim vs actual comparison ────────────────────────────────────────────────

/**
 * Print a comparison of simulated vs actual on-chain amounts for each leg.
 * @param {object} result — from verifyTrade (includes actuals, gasNano)
 * @param {Array<{sim, offerAddr}>} legs — simulated leg + the offer token for matching
 * @param {object} metaMap — addr → { symbol, decimals }
 * @param {object} priceMap — addr → usd price
 */
function printSimVsActual(result, legs, metaMap, priceMap) {
    const { actuals, gasNano } = result;
    if (!actuals?.length) return;

    const amt = (nano, addr) => fmtAmt(nano, metaMap[addr]?.symbol || addr.slice(0, 8), metaMap[addr]?.decimals ?? 9);
    const delta = (actual, sim) =>
        Number(sim) !== 0 ? ((Number(actual) - Number(sim)) / Number(sim) * 100).toFixed(2) : "?";

    const W  = 56;
    console.log(`\n${"─".repeat(W)}`);
    console.log(`  SIMULATED vs ACTUAL`);
    console.log("─".repeat(W));

    for (let i = 0; i < legs.length; i++) {
        const { sim, offerAddr } = legs[i];
        // Match actual by input token address
        const actual = actuals.find(a => a.inAddr === offerAddr && a.status === "ok");
        const label = legs.length > 1 ? `Leg ${String.fromCharCode(65 + i)}` : "Swap";

        if (actual) {
            const outDelta = delta(actual.amountOut, sim.amountOut);
            const sign = outDelta >= 0 ? "+" : "";
            console.log(`  ${label}:  ${amt(actual.amountIn, offerAddr)} → ${amt(actual.amountOut, sim.askAddr)}`);
            console.log(`          sim: ${amt(sim.amountOut, sim.askAddr)}  (Δ ${sign}${outDelta}%)`);
        } else {
            console.log(`  ${label}:  (not matched in on-chain event)`);
        }
    }

    // Gas
    if (gasNano > 0n) {
        const gasUsd = Number(gasNano) / 1e9 * (priceMap[TON] || 0);
        console.log(`  Gas:   ${(Number(gasNano) / 1e9).toFixed(4)} TON` +
                    (gasUsd > 0 ? ` ($${gasUsd.toFixed(2)})` : ""));
    }

    console.log("─".repeat(W));
}

// ── Post-failure diagnostics ────────────────────────────────────────────────

/**
 * After a swap fails on-chain, re-fetch current reserves and show
 * quoted vs current rate so we can tell if reserves shifted.
 */
async function printPostFailureRate(adapter, poolAddr, poolType, oldState, offerAddr, amountNano, quotedLeg, metaMap) {
    try {
        const now = await adapter(poolAddr);
        if (!now) return;
        now.poolType = poolType;
        now.token0 = now.token0 ?? oldState.token0;
        now.token1 = now.token1 ?? oldState.token1;
        now.feeBps = now.feeBps ?? oldState.feeBps;
        now.lpFeeBps = now.lpFeeBps ?? oldState.lpFeeBps;
        now.protocolFeeBps = now.protocolFeeBps ?? oldState.protocolFeeBps;
        now.amp = now.amp ?? oldState.amp;
        now.rate = now.rate ?? oldState.rate;
        now.w0 = now.w0 ?? oldState.w0;

        const nowSim = simulateSwapOnPool(now, offerAddr, amountNano, REFERRAL);
        if (!nowSim) return;

        const askDec = metaMap[quotedLeg.askAddr]?.decimals ?? 9;
        const askSym = metaMap[quotedLeg.askAddr]?.symbol ?? "?";

        const quotedOut = (Number(quotedLeg.amountOut) / 10 ** askDec).toFixed(Math.min(askDec, 6));
        const currentOut = (Number(nowSim.amountOut) / 10 ** askDec).toFixed(Math.min(askDec, 6));
        const diffPct = ((Number(nowSim.amountOut) - Number(quotedLeg.amountOut)) / Number(quotedLeg.amountOut) * 100).toFixed(3);
        const sign = diffPct >= 0 ? "+" : "";

        info(`Pool rate check → ${askSym}:`);
        info(`  Quoted:  ${quotedOut} ${askSym}`);
        info(`  Current: ${currentOut} ${askSym}  (${sign}${diffPct}%)`);
    } catch { /* best-effort */ }
}

// ── Post-trade verification ─────────────────────────────────────────────────

/**
 * After waitForSeqno confirms the wallet processed our message, fetch the
 * actual on-chain event to check if the swap(s) succeeded or failed.
 * Returns { ok, swaps, failed, error? }.
 */
async function verifyTrade(walletAddr, minAsks = [], afterUtime = 0) {
    const addr = walletAddr.toString({ bounceable: false });
    const { ourTxHash, event, error } = await fetchTradeEvent(addr, { afterUtime });
    if (error) return { ok: false, error };

    const actions = event.actions || [];
    const swapCount = actions.filter(a => a.type === "JettonSwap" && a.status === "ok").length;

    // Parse actual swap amounts from event
    const actuals = parseSwapAmounts(event);

    let minAskIdx = 0;
    const failedActions = actions
        .filter(a => a.status !== "ok")
        .map(a => {
            if (a.type === "JettonSwap") {
                const js = a.JettonSwap || a.jetton_swap;
                if (js) {
                    const inDec  = js.jetton_master_in?.decimals ?? 9;
                    const outDec = js.jetton_master_out?.decimals ?? 9;
                    const inSym  = js.jetton_master_in?.symbol ?? "?";
                    const outSym = js.jetton_master_out?.symbol ?? "?";
                    const inAmt  = (Number(js.amount_in) / 10 ** inDec).toFixed(Math.min(inDec, 4));
                    const outAmt = (Number(js.amount_out) / 10 ** outDec).toFixed(Math.min(outDec, 4));
                    const minAsk = minAsks[minAskIdx++];
                    const minAskStr = minAsk != null
                        ? ` (min_ask was ${(Number(minAsk) / 10 ** outDec).toFixed(Math.min(outDec, 4))})`
                        : "";
                    return `JettonSwap(${a.status}): ${inAmt} ${inSym} → ${outAmt} ${outSym}${minAskStr}`;
                }
            }
            const desc = a.simple_preview?.description || a.type;
            return `${a.type}(${a.status}): ${desc}`;
        });

    // Gas from value_flow
    let gasNano = 0n;
    if (event.value_flow) {
        for (const vf of event.value_flow) gasNano += BigInt(vf.fees || 0);
    }

    return {
        ok: failedActions.length === 0 && swapCount > 0,
        swaps: swapCount,
        failed: failedActions.length,
        failedActions,
        txHash: ourTxHash,
        actuals,
        gasNano,
    };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function dexLabel(poolType) {
    return poolType.startsWith("stonfi") ? "STONFI" : "DEDUST";
}

async function run(amountStr, tokenAddr, poolAddr, skipConfirm) {
    const { client, wallet, keyPair } = await createWallet();

    info(`Wallet: ${wallet.address.toString()}`);
    info(`Reserves: ${useRest ? "REST API" : "onchain get-methods"}`);

    // Pool detection + token metadata in parallel
    const [ifaces, startMeta] = await Promise.all([
        poolInterfaces(poolAddr),
        jettonMeta(tokenAddr),
    ]);

    let poolInfo = classifyPool(ifaces);
    if (poolInfo.type === "unknown") { error(`Could not identify pool type`); process.exit(1); }
    const poolType = poolInfo.type === "stonfi" ? `stonfi_${poolInfo.version}` : poolInfo.type;
    info(`Pool: ${poolAddr.slice(0, 20)}…  [${poolType}]`);

    const pool = { poolType, address: poolAddr };

    // Warmup pool metadata + init seqno in parallel
    const seqnoTracker = new SeqnoTracker(wallet);
    await Promise.all([
        warmupPoolMeta([pool]),
        seqnoTracker.init().then(s => info(`Seqno: ${s}`)),
    ]);

    // Fetch reserves
    const state = await ADAPTERS[poolType](poolAddr);
    if (!state) { error(`Could not fetch pool state`); process.exit(1); }

    state.poolType = poolType;
    state.token0 = state.token0 ?? pool.token0;
    state.token1 = state.token1 ?? pool.token1;
    state.feeBps = state.feeBps ?? pool.liveFeeBps;
    state.lpFeeBps = state.lpFeeBps ?? pool.lpFeeBps;
    state.protocolFeeBps = state.protocolFeeBps ?? pool.protocolFeeBps;
    state.amp = state.amp ?? pool.amp;
    state.rate = state.rate ?? pool.rate;
    state.w0 = state.w0 ?? pool.w0;

    // Warmup exec addresses (jetton wallets, DeDust vaults)
    await warmupPools(client, wallet.address, [
        { poolType, token0: state.token0, token1: state.token1, address: poolAddr, routerAddress: pool.routerAddress },
    ]).then(r => info(`Warmup: ${r.elapsed}ms`));

    poolInfo = poolTypeToInfo(poolType, pool);

    const amountNano = BigInt(Math.round(parseFloat(amountStr) * 10 ** startMeta.decimals));

    const balance = await getBalance(wallet.address, tokenAddr);
    checkBalance(balance, amountNano, tokenAddr, startMeta.symbol, startMeta.decimals);

    const sim = simulateSwapOnPool(state, tokenAddr, amountNano, REFERRAL);
    if (!sim) { error(`Swap simulation failed — token not in pool?`); process.exit(1); }

    const legA = { dex: dexLabel(poolType), ...sim, feePct: sim.feeBps / 100 };

    // Fetch metadata + prices (include TON for gas USD)
    const allAddrs = [...new Set([tokenAddr, legA.askAddr, TON])];
    const [metas, prices] = await Promise.all([
        Promise.all(allAddrs.map(jettonMeta)),
        Promise.all(allAddrs.map(usdPrice)),
    ]);
    const metaMap  = Object.fromEntries(allAddrs.map((a, i) => [a, metas[i]]));
    const priceMap = Object.fromEntries(allAddrs.map((a, i) => [a, prices[i]]));

    const toUsd = (nano, addr) => {
        const p = priceMap[addr], d = metaMap[addr]?.decimals ?? 9;
        return p ? Number(nano) / 10 ** d * p : null;
    };
    const amt = (nano, addr) => fmtAmt(nano, metaMap[addr]?.symbol || addr.slice(0, 8), metaMap[addr]?.decimals ?? 9);

    const W  = 56;
    const HR = "─".repeat(W);
    console.log(`\n${HR}`);
    console.log(`  Swap  [${legA.dex}]`);
    console.log(HR);
    console.log(`  In:           ${amt(amountNano, tokenAddr).padEnd(24)}(${fmtUsd(toUsd(amountNano, tokenAddr))})`);
    console.log(`  Out:          ${amt(legA.amountOut, legA.askAddr).padEnd(24)}(${fmtUsd(toUsd(legA.amountOut, legA.askAddr))})`);
    console.log(`  Fee:          ${amt(legA.feeAmount, tokenAddr).padEnd(24)}(${legA.feePct.toFixed(2)}%)`);
    if (REFERRAL > 0) console.log(`  Referral:     ${(REFERRAL / 100).toFixed(2)}%`);
    console.log(`  Price impact: ${(legA.priceImpact * 100).toFixed(4)}%`);
    console.log(`  Slippage:     ${(SLIPPAGE * 100).toFixed(1)}%  (tx reverts if worse)`);
    console.log(HR);

    // Confirmation
    if (!skipConfirm) {
        const ok = await confirm("\nExecute swap? (y/N) ");
        if (!ok) { console.log("Aborted."); process.exit(0); }
    }

    const minA = minAskAmount(legA.amountOut, SLIPPAGE);
    console.log(`\nBuilding swap…`);
    const legATx = await buildLeg(client, wallet.address, tokenAddr, legA.askAddr, amountNano, minA, poolInfo, poolAddr, REFERRAL);

    const seqno = seqnoTracker.current();
    const sendUtime = Math.floor(Date.now() / 1000) - 30; // 30s grace for clock skew
    console.log(`Sending swap (seqno: ${seqno})…`);
    await sendLegsWithSeqno(wallet, keyPair, [legATx], seqno);
    seqnoTracker.advance();
    console.log(`  Sent  (seqno: ${seqno})`);
    console.log(`  Waiting for confirmation…`);
    await waitForSeqno(wallet, seqno);
    console.log(`  Transaction landed on-chain. Verifying result…`);
    const result = await verifyTrade(wallet.address, [minA], sendUtime);
    if (result.ok) {
        console.log(`  ✓ Swap succeeded (${result.swaps} swap${result.swaps > 1 ? "s" : ""} confirmed on-chain)`);
        printSimVsActual(result, [{ sim: legA, offerAddr: tokenAddr }], metaMap, priceMap);
    } else if (result.error) {
        warn(`Could not verify: ${result.error}`);
    } else {
        warn(`Swap FAILED on-chain (${result.failed} action${result.failed > 1 ? "s" : ""} failed)`);
        for (const fa of result.failedActions) warn(`  ⚠ ${fa}`);
        if (result.txHash) info(`  https://tonviewer.com/transaction/${result.txHash}`);
        await printPostFailureRate(ADAPTERS[poolType], poolAddr, poolType, state, tokenAddr, amountNano, legA, metaMap);
    }
    console.log();
    seqnoTracker.stop();
}

// ── Best-rate swap ──────────────────────────────────────────────────────────

function resolvePoolType(ifaces) {
    const s = new Set(ifaces ?? []);
    for (const i of s) {
        if (i === "stonfi_pool") return "stonfi_v1";
        if (i.startsWith("stonfi_pool_v2")) return "stonfi_v2";
    }
    for (const i of s) {
        if (i.startsWith("dedust_pool")) return "dedust";
    }
    return null;
}

async function runBest(amountStr, offerAddr, askAddr, skipConfirm) {
    const { client, wallet, keyPair } = await createWallet();
    info(`Wallet: ${wallet.address.toString()}`);
    info(`Reserves: ${useRest ? "REST API" : "onchain get-methods"}`);

    // Find all pools containing both tokens
    const entries = readAddresses().filter(e => e.type === "dex_pool");
    const candidates = entries.filter(e => {
        const t0 = normTon(e.token0);
        const t1 = normTon(e.token1);
        return (t0 === offerAddr && t1 === askAddr) || (t1 === offerAddr && t0 === askAddr);
    });

    if (candidates.length === 0) {
        error(`No pools found for this pair in addresses.jsonl`);
        process.exit(1);
    }

    // Resolve pool types from interfaces
    const pools = [];
    for (const e of candidates) {
        let poolType = resolvePoolType(e.interfaces);
        if (!poolType) {
            const ifaces = await poolInterfaces(e.address);
            const classified = classifyPool(ifaces);
            if (classified.type === "unknown") continue;
            poolType = classified.type === "stonfi" ? `stonfi_${classified.version}` : classified.type;
        }
        pools.push({ poolType, address: e.address, label: e.label ?? e.address.slice(0, 12) });
    }

    if (pools.length === 0) {
        error(`No recognisable DEX pools for this pair`);
        process.exit(1);
    }

    info(`Found ${pools.length} pool${pools.length > 1 ? "s" : ""} for this pair`);

    // Warmup metadata
    await warmupPoolMeta(pools);

    // Fetch offer token metadata for amount parsing
    const offerMeta = await jettonMeta(offerAddr);
    const amountNano = BigInt(Math.round(parseFloat(amountStr) * 10 ** offerMeta.decimals));

    const balance = await getBalance(wallet.address, offerAddr);
    checkBalance(balance, amountNano, offerAddr, offerMeta.symbol, offerMeta.decimals);

    // Fetch reserves in parallel
    const stateResults = await Promise.all(pools.map(async (p) => {
        try {
            const state = await ADAPTERS[p.poolType](p.address);
            if (!state) return null;
            state.poolType = p.poolType;
            state.token0 = state.token0 ?? p.token0;
            state.token1 = state.token1 ?? p.token1;
            state.feeBps = state.feeBps ?? p.liveFeeBps;
            state.lpFeeBps = state.lpFeeBps ?? p.lpFeeBps;
            state.protocolFeeBps = state.protocolFeeBps ?? p.protocolFeeBps;
            state.amp = state.amp ?? p.amp;
            state.rate = state.rate ?? p.rate;
            state.w0 = state.w0 ?? p.w0;
            return state;
        } catch (e) {
            warn(`Failed to fetch reserves for ${p.address.slice(0, 12)}…: ${e.message}`);
            return null;
        }
    }));

    // Simulate swaps
    const results = [];
    for (let i = 0; i < pools.length; i++) {
        const state = stateResults[i];
        if (!state) continue;
        const sim = simulateSwapOnPool(state, offerAddr, amountNano, REFERRAL);
        if (!sim) continue;
        results.push({ pool: pools[i], state, sim });
    }

    if (results.length === 0) {
        error(`All pool simulations failed`);
        process.exit(1);
    }

    // Sort by output descending
    results.sort((a, b) => (b.sim.amountOut > a.sim.amountOut ? 1 : b.sim.amountOut < a.sim.amountOut ? -1 : 0));

    // Fetch metadata + prices for display
    const askMeta = await jettonMeta(askAddr);
    const allAddrs = [...new Set([offerAddr, askAddr, TON])];
    const prices = await Promise.all(allAddrs.map(usdPrice));
    const priceMap = Object.fromEntries(allAddrs.map((a, i) => [a, prices[i]]));

    const askDec = askMeta.decimals;
    const askSym = askMeta.symbol;
    const offerDec = offerMeta.decimals;
    const offerSym = offerMeta.symbol;
    const fmtOut = (nano) => (Number(nano) / 10 ** askDec).toFixed(Math.min(askDec, 6)).replace(/\.?0+$/, "");

    // Print comparison table
    const W = 72;
    const HR = "─".repeat(W);
    console.log(`\n${HR}`);
    console.log(`  Swap ${fmtAmt(amountNano, offerSym, offerDec)} → ${askSym}  (${results.length} pool${results.length > 1 ? "s" : ""})`);
    console.log(HR);
    console.log(`  ${"Pool".padEnd(26)} ${"DEX".padEnd(12)} ${"Out".padEnd(18)} ${"Fee".padEnd(8)} Impact`);
    console.log(`  ${"─".repeat(26)} ${"─".repeat(12)} ${"─".repeat(18)} ${"─".repeat(8)} ${"─".repeat(8)}`);

    const best = results[0];
    const worst = results[results.length - 1];

    for (const { pool, sim } of results) {
        const isBest = pool === best.pool;
        const outStr = `${fmtOut(sim.amountOut)} ${askSym}`;
        const tag = isBest && results.length > 1 ? " ★" : "";
        console.log(
            `  ${(pool.address.slice(0, 24) + "…").padEnd(26)} ` +
            `${dexLabel(pool.poolType).padEnd(12)} ` +
            `${outStr.padEnd(18)} ` +
            `${(sim.feeBps / 100).toFixed(2).padStart(5)}%  ` +
            `${(sim.priceImpact * 100).toFixed(4)}%${tag}`
        );
    }

    if (results.length > 1) {
        const diffPct = worst.sim.amountOut > 0n
            ? ((Number(best.sim.amountOut) - Number(worst.sim.amountOut)) / Number(worst.sim.amountOut) * 100).toFixed(2)
            : "∞";
        console.log(HR);
        console.log(`  Best: ${best.pool.address.slice(0, 12)}… [${dexLabel(best.pool.poolType)}]  →  ${fmtOut(best.sim.amountOut)} ${askSym}  (+${diffPct}% vs worst)`);
    }

    // USD value
    const outUsd = priceMap[askAddr] ? Number(best.sim.amountOut) / 10 ** askDec * priceMap[askAddr] : null;
    if (outUsd != null) console.log(`  Value: ${fmtUsd(outUsd)}`);
    if (REFERRAL > 0) console.log(`  Referral: ${(REFERRAL / 100).toFixed(2)}%`);
    console.log(`  Slippage: ${(SLIPPAGE * 100).toFixed(1)}%  (tx reverts if worse)`);
    console.log(HR);

    // Confirmation
    if (!skipConfirm) {
        const ok = await confirm(`\nExecute swap on ${best.pool.address.slice(0, 12)}… [${dexLabel(best.pool.poolType)}]? (y/N) `);
        if (!ok) { console.log("Aborted."); process.exit(0); }
    }

    // Build and execute on the winning pool
    const winPool = best.pool;
    const winState = best.state;
    const winSim = best.sim;

    const winPoolInfo = poolTypeToInfo(winPool.poolType, winPool);

    // Warmup exec addresses
    const warmupList = [{
        poolType: winPool.poolType,
        token0: winState.token0,
        token1: winState.token1,
        address: winPool.address,
        routerAddress: winPool.routerAddress,
    }];
    await warmupPools(client, wallet.address, warmupList).then(r => info(`Warmup: ${r.elapsed}ms`));

    const seqnoTracker = new SeqnoTracker(wallet);
    await seqnoTracker.init().then(s => info(`Seqno: ${s}`));

    const minA = minAskAmount(winSim.amountOut, SLIPPAGE);
    console.log(`\nBuilding swap…`);
    const legTx = await buildLeg(client, wallet.address, offerAddr, askAddr, amountNano, minA, winPoolInfo, winPool.address, REFERRAL);

    const seqno = seqnoTracker.current();
    const sendUtime = Math.floor(Date.now() / 1000) - 30;
    console.log(`Sending swap (seqno: ${seqno})…`);
    await sendLegsWithSeqno(wallet, keyPair, [legTx], seqno);
    seqnoTracker.advance();
    console.log(`  Sent  (seqno: ${seqno})`);
    console.log(`  Waiting for confirmation…`);
    await waitForSeqno(wallet, seqno);
    console.log(`  Transaction landed on-chain. Verifying result…`);

    const metaMap  = { [offerAddr]: offerMeta, [askAddr]: askMeta, [TON]: await jettonMeta(TON) };
    const result = await verifyTrade(wallet.address, [minA], sendUtime);
    if (result.ok) {
        console.log(`  ✓ Swap succeeded (${result.swaps} swap${result.swaps > 1 ? "s" : ""} confirmed on-chain)`);
        printSimVsActual(result, [{ sim: winSim, offerAddr }], metaMap, priceMap);
    } else if (result.error) {
        warn(`Could not verify: ${result.error}`);
    } else {
        warn(`Swap FAILED on-chain (${result.failed} action${result.failed > 1 ? "s" : ""} failed)`);
        for (const fa of result.failedActions) warn(`  ⚠ ${fa}`);
        if (result.txHash) info(`  https://tonviewer.com/transaction/${result.txHash}`);
        await printPostFailureRate(ADAPTERS[winPool.poolType], winPool.address, winPool.poolType, winState, offerAddr, amountNano, winSim, metaMap);
    }
    console.log();
    seqnoTracker.stop();
}

// ── Entry point ──────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const skipConfirm    = args.includes("--auto");
const useRest        = args.includes("--rest");
const slippageIdx    = args.findIndex(a => a === "--slippage");
const referralIdx    = args.findIndex(a => a === "--referral-value");
const MIN_SLIPPAGE   = 0.002; // 0.2%
const SLIPPAGE       = slippageIdx !== -1 ? Math.max(parseFloat(args[slippageIdx + 1]) / 100, MIN_SLIPPAGE) : DEFAULT_SLIPPAGE;
const REFERRAL       = referralIdx !== -1 ? Math.max(0, Math.min(100, parseInt(args[referralIdx + 1], 10) || 0)) : REFERRAL_VALUE;
const positional     = args.filter((a, i) => !a.startsWith("--") && (slippageIdx === -1 || i !== slippageIdx + 1) && (referralIdx === -1 || i !== referralIdx + 1));
const ADAPTERS       = useRest ? REST_ADAPTERS : POOL_ADAPTERS;

function usage() {
    console.log("Usage: node swap.js <amount> <from> <to>");
    console.log("");
    console.log("  Swap tokens on TON. Automatically finds the best rate");
    console.log("  across StonFi and DeDust pools.");
    console.log("");
    console.log("Examples:");
    console.log("  node swap.js 10 TON USDT        Swap 10 TON to USDT");
    console.log("  node swap.js 100 USDT TON       Swap 100 USDT to TON");
    console.log("  node swap.js 50 TON tsTON       Swap 50 TON to tsTON");
    console.log("");
    console.log(`Supported tokens: ${knownSymbols()}`);
    console.log("");
    console.log("Options:");
    console.log("  --slippage <n>       Max slippage in % (default: 1, min: 0.2)");
    console.log("  --referral-value <n> Referral fee in bps (default: 20, 0 to disable)");
    console.log("  --auto               Execute without confirmation (for scripts & cron)");
    console.log("");
    console.log("Setup:");
    console.log("  Export your wallet's 24 recovery words as an environment variable:");
    console.log('  export WALLET_PRIVATE_KEY="word1 word2 word3 ... word24"');
    console.log("");
    console.log("Advanced:");
    console.log("  <to> can be a pool address (EQ…) to swap on a specific pool");
    console.log("  --rest          Use REST APIs for pool data instead of on-chain calls");
    console.log("  TONAPI_KEY      TonAPI key for higher rate limits (env var)");
    console.log("  TONCENTER_KEY   Toncenter API key (env var)");
    console.log("  Hex seed also accepted as WALLET_PRIVATE_KEY (64-char hex)");
    console.log("");
    console.log("(c) 2026 Ask The Ocean | MIT");
    process.exit(1);
}

if (positional.length < 3) usage();

// Auto-detect mode: if the third arg resolves to a known token, use best-rate mode.
// If it looks like a pool address (EQ…/UQ…/0:…), use single-pool mode.
const thirdArg = positional[2];
const thirdAsToken = resolveToken(thirdArg);
const isPoolAddr = thirdArg.startsWith("EQ") || thirdArg.startsWith("UQ") || thirdArg.startsWith("0:");
const bestMode = thirdAsToken && !isPoolAddr;

if (bestMode) {
    const offerAddr = resolveToken(positional[1]);
    if (!offerAddr) { error(`Unknown token: "${positional[1]}". Known symbols: ${knownSymbols()}`); process.exit(1); }

    runBest(positional[0], offerAddr, thirdAsToken, skipConfirm).catch((e) => {
        error(e.message);
        process.exit(1);
    });
} else if (isPoolAddr) {
    const tokenAddr = resolveToken(positional[1]);
    if (!tokenAddr) {
        error(`Unknown token: "${positional[1]}". Known symbols: ${knownSymbols()}`);
        process.exit(1);
    }

    const poolArg = resolvePoolAddr(thirdArg);
    run(positional[0], tokenAddr, poolArg, skipConfirm).catch((e) => {
        error(e.message);
        process.exit(1);
    });
} else {
    error(`Unknown token or pool: "${thirdArg}". Use a known symbol or a pool address (EQ…).`);
    error(`Known symbols: ${knownSymbols()}`);
    process.exit(1);
}
