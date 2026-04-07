/**
 * lib/addr.js — TON address format conversion helpers
 *
 * TON addresses have one identity (workchain + 32-byte hash) but two common
 * string representations:
 *
 *   Raw    "0:3e5ffca8…"   — workchain:hexhash  (machine / API internal format)
 *   EQ     "EQA-X_yo3f…"  — base64url(flag + workchain + hash + crc16)
 *                            flag 0x11 = bounceable  → "EQ…"
 *                            flag 0x51 = non-bounceable → "UQ…"
 *
 * We store and display everything in EQ (bounceable, url-safe base64) format.
 * Raw format is used only when comparing against API responses that emit
 * raw addresses.
 *
 * Exports:
 *   toEQ(addr)   — normalise any format to EQ base64url string
 *   toRaw(addr)  — normalise any format to "0:hexhash" string
 *   isRaw(addr)  — true if string looks like a raw TON address
 *   isEQ(addr)   — true if string looks like a friendly TON address
 */

import { Address } from "@ton/ton";

const TON_SENTINEL = "TON";

/**
 * Return true if addr looks like a raw "0:hexhash" address.
 */
export function isRaw(addr) {
    return typeof addr === "string" && /^-?\d+:[0-9a-fA-F]{64}$/.test(addr);
}

/**
 * Return true if addr looks like a friendly EQ/UQ base64url address.
 */
export function isEQ(addr) {
    return typeof addr === "string" && /^[A-Za-z0-9_-]{48}$/.test(addr);
}

/**
 * Normalise any TON address string to EQ (bounceable, url-safe base64) format.
 * "TON" sentinel is passed through unchanged.
 * Returns the original string unchanged if it can't be parsed.
 */
export function toEQ(addr) {
    if (!addr || addr === TON_SENTINEL) return addr;
    try {
        if (isRaw(addr)) {
            return Address.parseRaw(addr).toString({ bounceable: true, urlSafe: true });
        }
        if (isEQ(addr)) {
            // Re-serialise to ensure bounceable + urlSafe even if it was UQ
            return Address.parseFriendly(addr).address.toString({ bounceable: true, urlSafe: true });
        }
    } catch { /* fall through */ }
    return addr;
}

/**
 * Normalise any TON address string to raw "0:hexhash" format.
 * "TON" sentinel is passed through unchanged.
 * Returns the original string unchanged if it can't be parsed.
 */
export function toRaw(addr) {
    if (!addr || addr === TON_SENTINEL) return addr;
    try {
        if (isRaw(addr)) return addr;
        if (isEQ(addr)) {
            return Address.parseFriendly(addr).address.toRawString();
        }
    } catch { /* fall through */ }
    return addr;
}
