#!/bin/bash
# ── Wallet config ────────────────────────────────────────────────────
# Paste your 24 recovery words below (from Tonkeeper, Tonhub, etc.)
# Uncomment the line and replace the placeholder words with your own.

# export WALLET_PRIVATE_KEY="word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12 word13 word14 word15 word16 word17 word18 word19 word20 word21 word22 word23 word24"

# ── Optional API keys ────────────────────────────────────────────────
# export TONAPI_KEY=""
# export TONCENTER_KEY=""

# ── Run ──────────────────────────────────────────────────────────────
node swap.js "$@"
