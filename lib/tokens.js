/**
 * lib/tokens.js — Token registry + address resolution
 *
 * Single source of truth for symbol → address mappings.
 *
 * resolveToken(symbolOrAddr) accepts:
 *   "TON"        → "TON"  (sentinel used throughout the codebase)
 *   "tsTON"      → EQC98_... (case-insensitive symbol lookup)
 *   "USDT"       → EQCxE6...
 *   "EQ..."      → passed through as-is (raw address)
 *   unknown str  → null
 */

export const TON = "TON";

// Symbol → { address, decimals }
// Keys are the canonical display symbols (casing matters for display).
export const TOKENS = {
    TON:     { address: "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",    decimals: 9 },
    USDT:    { address: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",  decimals: 6 },
    tsTON:   { address: "EQC98_qAmNEptUtPc7W6xdHh_ZHrBUFpw5Ft_IzNU20QAJav",  decimals: 9 },
    STON:    { address: "EQA2kCVNwVsil2EM2mB0SkXytxCqQjS4mttjDpnXmwG9T6bO",  decimals: 9 },
    NOT:     { address: "EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM66bKy",  decimals: 9 },
    DOGS:    { address: "EQCvxJy4eG8hyHBFsZ7eePxrRsUQSFE_jpptRAYBmcG_DOGS",  decimals: 0 },
    HMSTR:   { address: "EQAJ8uWOehbNEbhGBxMsCVNIAMcIkhgfCj1BkEhvhFN4-Hmstr", decimals: 9 },
    STORM:   { address: "EQBsosmcZrD6FHijA7qWGLw5wo_aH8UN435hi935jJ_STORM",   decimals: 9 },
    jUSDC:   { address: "EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728",  decimals: 6 },
    JETTON:  { address: "EQAQXlWJvGbbFfE8F3oS8s87lIgdovS455IsWFaRdmJetTon",   decimals: 9 },
    GEMSTON: { address: "EQBX6K9aXVl3nXINCyPPL86C4ONVmQ8vK360u6dykFKXpHCa",  decimals: 9 },
    ECOR:    { address: "EQDc_nrm5oOVCVQM8GRJ5q_hr1jgpNQjsGkIGE-uztt26_Ep",  decimals: 9 },
    USDe:    { address: "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f",  decimals: 6 },
    XAUt:    { address: "EQA1R_LuQCLHlMgOo1S4G7Y7W1cd0FrAkbA10Zq7rddKxi9k",  decimals: 6 },
};

// Uppercase alias → canonical TOKENS key (for resolveToken case-insensitive lookup).
// Only non-trivial mappings needed — the auto-index handles the trivial ones.
const ALIASES = {
    TSTONE: "tsTON",
    TSTON:  "tsTON",
};

// Build uppercase lookup index: "TSton" → "tsTON", "JUSDC" → "jUSDC", etc.
const LOOKUP = Object.fromEntries(
    Object.keys(TOKENS).map(k => [k.toUpperCase(), k])
);

// pTON addresses StonFi uses internally — normalize to "TON"
export const PTON_ADDRS = new Set([
    "EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c",    // pTON v1
    "EQBnGWMCf3-FZZq1W4IWcWiGAc3PHuZ0_H-7sad2oY00o83S",  // pTON v2.1 (shared by all v2 routers)
]);

export const normTon = (addr) => PTON_ADDRS.has(addr) ? TON : addr;

/**
 * Resolve a symbol or raw address to a canonical address (or "TON").
 * Returns null if the symbol is unknown.
 */
export function resolveToken(symbolOrAddr) {
    if (!symbolOrAddr) return null;
    const upper = symbolOrAddr.toUpperCase();

    if (upper === "TON") return TON;

    const key = ALIASES[upper] ?? LOOKUP[upper];
    if (key && TOKENS[key]) return TOKENS[key].address;

    // Raw address — pass through
    if (symbolOrAddr.startsWith("EQ") || symbolOrAddr.startsWith("UQ") || symbolOrAddr.startsWith("0:")) {
        return symbolOrAddr;
    }

    return null;
}

/** List all known symbols (for help text) */
export const knownSymbols = () => Object.keys(TOKENS).join(", ");

/** Reverse lookup: address → { symbol, decimals } or null */
export function tokenByAddress(addr) {
    if (!addr || addr === TON) return { symbol: "TON", decimals: 9 };
    for (const [symbol, info] of Object.entries(TOKENS)) {
        if (info.address === addr) return { symbol, decimals: info.decimals };
    }
    return null;
}
