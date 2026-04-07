/**
 * lib/log.js — Unified logger.
 *
 * Format:  [2026-04-04 14:23:07.318] LEVEL  category: message
 *
 * Levels:  ERROR > WARN > INFO > DEBUG
 * All output goes to stderr (keeps stdout clean for JSON/data piping).
 *
 * Usage:
 *   import { info, warn, error, debug, setVerbose } from "./lib/log.js";
 *   info("exec", "trade started");      // [ts] INFO  exec: trade started
 *   warn("api", "rate limited");         // [ts] WARN  api: rate limited
 *   error("exec", "FAILED: timeout");    // [ts] ERROR exec: FAILED: timeout
 *   debug("pool", "fetching reserves");  // [ts] DEBUG pool: fetching reserves  (only if verbose)
 *   info("loaded 5 pools");              // [ts] INFO  loaded 5 pools  (no category)
 */

let _verbose = false;

export function setVerbose(v) { _verbose = v; }
export function isVerbose()   { return _verbose; }

function timestamp() {
    const d = new Date();
    return d.toISOString().replace("T", " ").slice(0, 23); // "2026-04-04 14:23:07.318"
}

function fmt(level, categoryOrMsg, msg) {
    const ts = timestamp();
    const lvl = level.padEnd(5); // "INFO ", "WARN ", "ERROR", "DEBUG"
    if (msg !== undefined) {
        return `[${ts}] ${lvl} ${categoryOrMsg}: ${msg}`;
    }
    return `[${ts}] ${lvl} ${categoryOrMsg}`;
}

export function error(categoryOrMsg, msg) {
    process.stderr.write(fmt("ERROR", categoryOrMsg, msg) + "\n");
}

export function warn(categoryOrMsg, msg) {
    process.stderr.write(fmt("WARN", categoryOrMsg, msg) + "\n");
}

export function info(categoryOrMsg, msg) {
    process.stderr.write(fmt("INFO", categoryOrMsg, msg) + "\n");
}

export function debug(categoryOrMsg, msg) {
    if (!_verbose) return;
    process.stderr.write(fmt("DEBUG", categoryOrMsg, msg) + "\n");
}
