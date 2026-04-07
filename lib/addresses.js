/**
 * lib/addresses.js — Load and resolve pool entries from local/addresses.jsonl
 */

import { readFileSync }                                       from "fs";
import { resolve }                                            from "path";
import { toEQ }                                              from "./addr.js";
import { warn }                                              from "./log.js";

const ADDRESSES_FILE    = resolve("local/addresses.jsonl");

// ── Raw file access ───────────────────────────────────────────────────────────

export function readAddresses() {
    try {
        return readFileSync(ADDRESSES_FILE, "utf8")
            .trim().split("\n").filter(Boolean)
            .map(l => {
                try {
                    const e = JSON.parse(l);
                    // Normalise address to EQ format regardless of how it was stored
                    if (e.address) e.address = toEQ(e.address) ?? e.address;
                    return e;
                }
                catch { warn("addresses", `bad line in addresses.jsonl, skipping: ${l.slice(0, 60)}`); return null; }
            })
            .filter(Boolean);
    } catch {
        return [];
    }
}

/**
 * Resolve a (possibly abbreviated) pool address to a full EQ… address.
 * Matches against addresses.jsonl entries by prefix. Throws if ambiguous or not found.
 */
export function resolvePoolAddr(input) {
    if (!input) return input;
    // Already a full-length raw address — return as-is
    if (input.length >= 48) return input;
    const entries = readAddresses().filter(e => e.type === "dex_pool");
    const matches = entries.filter(e => e.address.startsWith(input));
    if (matches.length === 1) return matches[0].address;
    if (matches.length === 0) throw new Error(`No pool in addresses.jsonl matches prefix "${input}"`);
    const labels = matches.map(m => `  ${m.address.slice(0, 12)}… ${m.label ?? ""}`).join("\n");
    throw new Error(`Ambiguous prefix "${input}" matches ${matches.length} pools:\n${labels}`);
}


