/**
 * lib/exec.js — Wallet setup, swap building, and on-chain execution
 */

import { TonClient, WalletContractV4, JettonMaster, Address, toNano, SendMode, internal } from "@ton/ton";
import { keyPairFromSeed, mnemonicToWalletKey } from "@ton/crypto";
import { DEX, pTON } from "@ston-fi/sdk";
import {
    Factory,
    MAINNET_FACTORY_ADDR,
    JettonRoot,
    VaultJetton,
    Pool,
} from "@dedust/sdk";
import { TON } from "./tokens.js";
import { getJson } from "./tonapi.js";
import { STONFI_BASE } from "./pools.js";
import { warn } from "./log.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// StonFi v2.1 — SDK v2.7.0 removed default addresses from Router and pTON constructors
const STONFI_V2_ROUTER_ADDR = Address.parse("EQCS4UEa5UaJLzOyyKieqQOQ2P9M-7kXpkO5HnP3Bv250cN3");
const STONFI_V2_PTON_ADDR   = Address.parse("EQBnGWMCf3-FZZq1W4IWcWiGAc3PHuZ0_H-7sad2oY00o83S");

// Referral fee — shown in the swap summary before confirmation.
// Override with --referral-value <bps>.
export const REFERRAL_ADDR  = "UQAZHwtwM5bWdQwrs50bCrfSXwFMRSFadZL94MVH_G7_ZTse";
export const REFERRAL_VALUE = 20; // basis points (0.20%)

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_SLIPPAGE = 0.01;

// ── Wallet ───────────────────────────────────────────────────────────────────

/**
 * Create a TonClient + WalletV4 from environment variables.
 * Throws if WALLET_PRIVATE_KEY is missing or malformed.
 *
 * Returns { client, wallet, keyPair }
 */
export async function createWallet() {
    const pk = process.env.WALLET_PRIVATE_KEY;
    if (!pk) {
        throw new Error("WALLET_PRIVATE_KEY is not set. Use your 24 recovery words (space-separated) or a 64-char hex seed.");
    }

    const isMnemonic = pk.includes(" ");
    const keyPair = isMnemonic
        ? await mnemonicToWalletKey(pk.trim().split(/\s+/))
        : keyPairFromSeed(Buffer.from(pk, "hex"));
    const client  = new TonClient({
        endpoint: "https://toncenter.com/api/v2/jsonRPC",
        apiKey:   process.env.TONCENTER_KEY,
    });
    const wallet = client.open(
        WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 })
    );

    return { client, wallet, keyPair };
}

// ── Slippage ─────────────────────────────────────────────────────────────────

/**
 * Apply slippage guard: reduce expected output by slippage %.
 * Transaction reverts if actual output is below this amount.
 */
export function minAskAmount(amountOut, slippage = DEFAULT_SLIPPAGE) {
    return amountOut * BigInt(Math.floor((1 - slippage) * 10_000)) / 10_000n;
}

// ── Pool type helpers ────────────────────────────────────────────────────────

/**
 * Convert poolType string + pool metadata → { type, version, routerAddress?, isStable? } for buildLeg.
 * @param {string} poolType — "stonfi_v1", "stonfi_v2", "dedust"
 * @param {object} [pool] — pool object with routerAddress, amp from warmup
 */
export function poolTypeToInfo(poolType, pool) {
    if (poolType === "stonfi_v1") return { type: "stonfi", version: "v1" };
    if (poolType === "stonfi_v2") {
        const routerAddress = pool?.routerAddress;
        const ptonKey = `stonfi:pton-wallet:${routerAddress || STONFI_V2_ROUTER_ADDR.toString()}`;
        return {
            type: "stonfi", version: "v2",
            routerAddress,
            isStable: pool?.amp != null,
            ptonWallet: _stonfiAddrs.get(ptonKey),
        };
    }
    if (poolType === "dedust")    return { type: "dedust" };
    return { type: "unknown" };
}

// ── Build swap tx params (no sending) ────────────────────────────────────────

// StonFi jetton wallet addresses resolved once at startup via warmupStonfi().
// Key: "stonfi:{version}:{jettonAddr}:{ownerAddr}" → Address
const _stonfiAddrs = new Map();

/**
 * Pre-resolve StonFi jetton wallet addresses for all token/owner combos.
 * The SDK normally resolves these per-call via RPC; pre-resolving eliminates
 * that latency at trade time.
 *
 * @param {TonClient} client
 * @param {Address} walletAddr - the trading wallet address
 * @param {Array<{tokenAddr: string, version: string, routerAddress?: string}>} tokens
 */
export async function warmupStonfi(client, walletAddr, tokens) {
    const seen = new Set();
    const tasks = [];

    // Resolve pTON wallet address for each unique v2 router via StonFi API.
    // The SDK's on-chain get_wallet_address returns wrong addresses for some
    // routers (e.g. WStable), so we use the API as source of truth.
    const routersSeen = new Set();
    for (const { version, routerAddress } of tokens) {
        if (version === "v1") continue;
        const rAddr = routerAddress || STONFI_V2_ROUTER_ADDR.toString();
        if (routersSeen.has(rAddr)) continue;
        routersSeen.add(rAddr);
        tasks.push(
            getJson(`${STONFI_BASE}/v1/routers/${rAddr}`, {}, { label: `stonfi-router ${rAddr.slice(0, 8)}…` })
                .then(data => {
                    const wallet = (data?.router || data)?.pton_wallet_address;
                    if (!wallet) throw new Error(`StonFi API returned no pton_wallet_address for router ${rAddr}`);
                    _stonfiAddrs.set(`stonfi:pton-wallet:${rAddr}`, Address.parse(wallet));
                })
        );
    }

    for (const { tokenAddr, version, routerAddress } of tokens) {
        if (tokenAddr === TON) continue; // TON uses pTON proxy, no wallet resolution

        const isV1 = version === "v1";
        const routerAddr = isV1
            ? client.open(new DEX.v1.Router()).address
            : routerAddress ? Address.parse(routerAddress) : STONFI_V2_ROUTER_ADDR;

        const minter = client.open(JettonMaster.create(Address.parse(tokenAddr)));

        // Resolve jetton wallet for the user wallet (needed for offer side)
        const userKey = `stonfi:${version}:${tokenAddr}:${walletAddr.toString()}`;
        if (!seen.has(userKey)) {
            seen.add(userKey);
            tasks.push(
                minter.getWalletAddress(walletAddr)
                    .then(addr => _stonfiAddrs.set(userKey, addr))
            );
        }

        // Resolve jetton wallet for the router (needed for ask side)
        const routerKey = `stonfi:${version}:${tokenAddr}:${routerAddr.toString()}`;
        if (!seen.has(routerKey)) {
            seen.add(routerKey);
            tasks.push(
                minter.getWalletAddress(routerAddr)
                    .then(addr => _stonfiAddrs.set(routerKey, addr))
            );
        }
    }

    await Promise.all(tasks);
    return { addrs: tasks.length, tokens: new Set(tokens.filter(t => t.tokenAddr !== TON).map(t => t.tokenAddr)).size };
}

function _getStonfiWalletAddr(version, tokenAddr, ownerAddr) {
    const key = `stonfi:${version}:${tokenAddr}:${ownerAddr.toString()}`;
    const addr = _stonfiAddrs.get(key);
    if (!addr) {
        warn("exec", `StonFi wallet cache MISS: ${key}  (will trigger on-chain RPC fallback)`);
        warn("exec", `  cached keys: ${[..._stonfiAddrs.keys()].join(", ")}`);
    }
    return addr;
}

/**
 * Build StonFi swap tx params.
 * Returns { to, value, body } — ready to include in a wallet transfer.
 * Uses pre-resolved jetton wallet addresses from warmupStonfi() when available.
 *
 * @param {string} version — "v1" or "v2"
 * @param {object} [opts]
 * @param {string} [opts.routerAddress] — pool's router address (for stableswap/weighted pools)
 * @param {boolean} [opts.isStable] — use WStable router class instead of CPI
 * @param {Address} [opts.ptonWallet] — pre-resolved pTON wallet on the router (from StonFi API)
 */
export async function buildStonfiSwap(client, walletAddr, offerAddr, askAddr, amountNano, minAsk, version, referralValue, opts = {}) {
    const isV1 = version === "v1";
    let router;
    if (isV1) {
        router = client.open(new DEX.v1.Router());
    } else if (opts.isStable && opts.routerAddress) {
        router = client.open(new DEX.v2_2.Router.WStable(Address.parse(opts.routerAddress)));
    } else {
        router = client.open(new DEX.v2_1.Router(opts.routerAddress ? Address.parse(opts.routerAddress) : STONFI_V2_ROUTER_ADDR));
    }
    const ptonAddr = STONFI_V2_PTON_ADDR;
    const proxy = isV1 ? new pTON.v1() : new pTON.v2_1(ptonAddr);

    // pTON wallet on the router — pre-resolved from StonFi API during warmup.
    // The SDK's on-chain get_wallet_address returns wrong addresses for some routers
    // (e.g. WStable), so we always pass it explicitly to bypass SDK resolution.
    const ptonWallet = opts.ptonWallet;

    if (offerAddr === TON) {
        return router.getSwapTonToJettonTxParams({
            userWalletAddress:    walletAddr.toString(),
            proxyTon:             proxy,
            offerAmount:          amountNano.toString(),
            offerJettonWalletAddress: ptonWallet,
            askJettonAddress:     askAddr,
            askJettonWalletAddress: _getStonfiWalletAddr(version, askAddr, router.address),
            minAskAmount:         minAsk.toString(),
            referralAddress:      REFERRAL_ADDR,
            referralValue:        referralValue,
        });
    } else if (askAddr === TON) {
        return router.getSwapJettonToTonTxParams({
            userWalletAddress:        walletAddr.toString(),
            proxyTon:                 proxy,
            offerJettonAddress:       offerAddr,
            offerJettonWalletAddress: _getStonfiWalletAddr(version, offerAddr, walletAddr),
            askJettonWalletAddress:   ptonWallet,
            offerAmount:              amountNano.toString(),
            minAskAmount:             minAsk.toString(),
            referralAddress:          REFERRAL_ADDR,
            referralValue:            referralValue,
        });
    } else {
        return router.getSwapJettonToJettonTxParams({
            userWalletAddress:        walletAddr.toString(),
            offerJettonAddress:       offerAddr,
            offerJettonWalletAddress: _getStonfiWalletAddr(version, offerAddr, walletAddr),
            offerAmount:              amountNano.toString(),
            askJettonAddress:         askAddr,
            askJettonWalletAddress:   _getStonfiWalletAddr(version, askAddr, router.address),
            minAskAmount:             minAsk.toString(),
            referralAddress:          REFERRAL_ADDR,
            referralValue:            referralValue,
        });
    }
}

/**
 * Build DeDust swap tx params.
 * Uses a capture sender to intercept what the SDK would send.
 * Returns { to, value, body } — ready to include in a wallet transfer.
 */

// DeDust vault/wallet addresses resolved once at startup via warmupDedust().
const _dedustAddrs = new Map(); // key → resolved contract wrapper

/**
 * Pre-resolve all DeDust vault and jetton wallet addresses for the pools we'll swap on.
 * Call once at startup so buildDedustSwap has zero RPC overhead.
 *
 * @param {TonClient} client - opened TonClient
 * @param {Address} walletAddr - the trading wallet address
 * @param {Array<{offerAddr: string, poolAddr: string}>} legs - unique (offerAddr, poolAddr) pairs
 * @returns {{ addrs: number, tokens: number }}
 */
export async function warmupDedust(client, walletAddr, legs) {
    const factory = client.open(Factory.createFromAddress(MAINNET_FACTORY_ADDR));

    // Always resolve native vault
    const nativeVault = await factory.getNativeVault();
    _dedustAddrs.set("native-vault", nativeVault);
    let addrs = 1;

    // Resolve jetton vaults and wallets for each unique offer token
    const seen = new Set();
    for (const { offerAddr } of legs) {
        if (offerAddr === TON || seen.has(offerAddr)) continue;
        seen.add(offerAddr);

        const jettonRoot = client.open(JettonRoot.createFromAddress(Address.parse(offerAddr)));
        const [jettonWalletAddr, vaultAddr] = await Promise.all([
            jettonRoot.getWallet(walletAddr),
            factory.getJettonVault(Address.parse(offerAddr)),
        ]);
        _dedustAddrs.set(`jetton-wallet:${offerAddr}`, jettonWalletAddr);
        _dedustAddrs.set(`jetton-vault:${offerAddr}`, vaultAddr);
        addrs += 2;
    }
    return { addrs, tokens: seen.size };
}

export async function buildDedustSwap(client, walletAddr, offerAddr, askAddr, amountNano, minAsk, poolAddr, referralValue) {
    const pool     = client.open(Pool.createFromAddress(Address.parse(poolAddr)));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);

    // Capture sender — records the tx params the SDK wants to send
    let captured = null;
    const captureSender = { send: (args) => { captured = args; }, address: walletAddr };

    const swapParams = { deadline, referralAddress: Address.parse(REFERRAL_ADDR) };

    if (offerAddr === TON) {
        const vault = client.open(_dedustAddrs.get("native-vault"));
        await vault.sendSwap(captureSender, {
            poolAddress: pool.address,
            amount:      amountNano,
            limit:       minAsk,
            gasAmount:   toNano("0.25"),
            swapParams,
        });
    } else {
        const jettonWallet = client.open(_dedustAddrs.get(`jetton-wallet:${offerAddr}`));
        const vault        = client.open(_dedustAddrs.get(`jetton-vault:${offerAddr}`));

        if (!jettonWallet || !vault) {
            throw new Error(`DeDust addresses not warmed up for token ${offerAddr.slice(0, 12)}… — call warmupDedust() at startup`);
        }

        await jettonWallet.sendTransfer(captureSender, toNano("0.3"), {
            amount:          amountNano,
            destination:     vault.address,
            responseAddress: walletAddr,
            forwardAmount:   toNano("0.25"),
            forwardPayload:  VaultJetton.createSwapPayload({
                poolAddress: pool.address,
                limit:       minAsk,
                swapParams,
            }),
        });
    }

    if (!captured) throw new Error("DeDust SDK did not produce a transaction");
    return captured;
}

/**
 * Warm up all DEX addresses for a set of pool descriptors.
 * Runs StonFi and DeDust warmups in parallel.
 *
 * @param {TonClient} client
 * @param {Address} walletAddr
 * @param {Array<{poolType: string, token0: string, token1: string, address: string}>} pools
 * @returns {{ stonfi: {addrs, tokens}|null, dedust: {addrs, tokens}|null, elapsed: number }}
 */
export async function warmupPools(client, walletAddr, pools) {
    const t0 = Date.now();
    const tasks = [];
    let stonfiResult = null, dedustResult = null;

    const stonfiPools = pools.filter(p => p.poolType.startsWith("stonfi"));
    if (stonfiPools.length) {
        const tokens = [];
        for (const p of stonfiPools) {
            const ver = p.poolType === "stonfi_v1" ? "v1" : "v2";
            tokens.push({ tokenAddr: p.token0, version: ver, routerAddress: p.routerAddress });
            tokens.push({ tokenAddr: p.token1, version: ver, routerAddress: p.routerAddress });
        }
        tasks.push(warmupStonfi(client, walletAddr, tokens).then(r => { stonfiResult = r; }));
    }

    const dedustPools = pools.filter(p => p.poolType === "dedust");
    if (dedustPools.length) {
        const legs = [];
        for (const p of dedustPools) {
            legs.push({ offerAddr: p.token0, poolAddr: p.address });
            legs.push({ offerAddr: p.token1, poolAddr: p.address });
        }
        tasks.push(warmupDedust(client, walletAddr, legs).then(r => { dedustResult = r; }));
    }

    if (tasks.length) await Promise.all(tasks);
    return { stonfi: stonfiResult, dedust: dedustResult, elapsed: Date.now() - t0 };
}

/**
 * Build swap tx params for any supported pool type.
 * Returns { to, value, body }. Uses pre-resolved addresses — zero RPC calls.
 */
export async function buildLeg(client, walletAddr, offerAddr, askAddr, amountNano, minAsk, poolInfo, poolAddr, referralValue = REFERRAL_VALUE) {
    if (poolInfo.type === "stonfi") {
        return buildStonfiSwap(client, walletAddr, offerAddr, askAddr, amountNano, minAsk, poolInfo.version, referralValue, {
            routerAddress: poolInfo.routerAddress,
            isStable: poolInfo.isStable,
            ptonWallet: poolInfo.ptonWallet,
        });
    }
    if (poolInfo.type === "dedust") {
        return buildDedustSwap(client, walletAddr, offerAddr, askAddr, amountNano, minAsk, poolAddr, referralValue);
    }
    throw new Error(`Unsupported pool type: ${poolInfo.type}`);
}

// ── Seqno tracking ──────────────────────────────────────────────────────────

/**
 * Local seqno tracker — fetches from chain at startup and every 60s,
 * increments locally after each send. The background poll ensures we
 * stay in sync if the wallet is used elsewhere.
 */
export class SeqnoTracker {
    constructor(wallet) { this._wallet = wallet; this._seqno = null; this._interval = null; }

    /** Fetch current seqno from chain and start background polling (jittered). */
    async init() {
        this._seqno = await this._wallet.getSeqno();
        const poll = async () => {
            try {
                const chain = await this._wallet.getSeqno();
                if (chain > this._seqno) this._seqno = chain;
            } catch { /* ignore — keep local value */ }
            // Jitter 45–75s to avoid sync with other periodic tasks
            this._timer = setTimeout(poll, 45_000 + Math.random() * 30_000);
        };
        this._timer = setTimeout(poll, 45_000 + Math.random() * 30_000);
        return this._seqno;
    }

    /** Return current seqno (synchronous, no RPC). */
    current() {
        if (this._seqno == null) throw new Error("SeqnoTracker not initialized — call init() first");
        return this._seqno;
    }

    /** Advance seqno after a successful send. */
    advance() { this._seqno++; }

    /** Stop background polling (lets the process exit cleanly in CLI tools). */
    stop() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }
}

// ── Send legs ────────────────────────────────────────────────────────────────

/**
 * Send one or more swap legs in a single wallet transfer.
 * All legs are included as internal messages in one external message,
 * so they're processed atomically by the wallet contract.
 *
 * Accepts a pre-fetched seqno to avoid an extra RPC round-trip.
 */
export async function sendLegsWithSeqno(wallet, keyPair, legs, seqno) {
    const messages = legs.map(leg => internal({
        to:    leg.to,
        value: leg.value,
        body:  leg.body,
    }));

    await wallet.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
    });
}

// ── Confirmation wait ────────────────────────────────────────────────────────

/**
 * Poll wallet seqno until it advances past the given value.
 * Used to confirm a transaction has landed on-chain.
 */
export async function waitForSeqno(wallet, seqno, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(3_000);
        try {
            const current = await wallet.getSeqno();
            if (current > seqno) return;
        } catch { /* chain might be slow, keep polling */ }
    }
    throw new Error(`Timeout waiting for seqno ${seqno} to advance (>${timeoutMs / 1000}s)`);
}
