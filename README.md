# ton-swap

Swap TON tokens at the best rate available — no exchange account, no KYC, no withdrawal fees. ton-swap queries StonFi and DeDust pools in real time and automatically executes on the one with the highest output. Your keys never leave your machine, slippage is configurable, and the whole thing runs from a single command — or unattended on a cron schedule.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Copy the example config:
   ```
   cp run.example.sh run.sh
   ```

3. Open `run.sh` and paste your **24 recovery words**. In Tonkeeper: Settings > Wallet > Back up (other wallets like Tonhub, MyTonWallet have a similar option under security or backup settings).

4. Make sure the wallet has TON for gas fees (1 TON is reserved automatically when swapping TON).

`run.sh` is gitignored so your keys stay local.

## Usage

```
./run.sh 10 TON USDT          # swap 10 TON to USDT
./run.sh 100 USDT TON --auto  # swap 100 USDT to TON, no confirmation
./run.sh 50 TON tsTON         # swap 50 TON to tsTON
```

### Options

| Flag | Description |
|---|---|
| `--auto` | Execute without confirmation (for scripts & cron) |
| `--slippage <n>` | Max slippage in % (default: 1, min: 0.2) |
| `--referral-value <n>` | Referral fee in basis points (default: 20, i.e. 0.20%) |

### Supported tokens

TON, USDT, tsTON, STON, NOT, DOGS, HMSTR, STORM, jUSDC, JETTON, GEMSTON, ECOR, USDe, XAUt

## Scheduled swaps

Use `--auto` with cron to run swaps on a schedule. For example, swap 100 TON to USDT every day at 9am:

```
crontab -e
```

```
0 9 * * * cd /path/to/ton-swap && ./run.sh 100 TON USDT --auto >> swap.log 2>&1
```

This will automatically pick the best pool and execute. Check `swap.log` for results.

## Advanced

### Specific pool

Pass a pool address (EQ...) as the third argument to bypass best-rate selection:

```
./run.sh 5 TON EQCGScrZe1xbyWqWDvdI6mzP-GAcAWFv6ZXuaJOuSqemxku4
```

### API keys

For higher rate limits, uncomment and fill in the API keys in `run.sh`:

| Variable | Source |
|---|---|
| `TONAPI_KEY` | [tonapi.io](https://tonapi.io) |
| `TONCENTER_KEY` | [toncenter.com](https://toncenter.com) |

### Reserve data source

By default, pool reserves are fetched via on-chain get-methods (most accurate). Use `--rest` to fetch from StonFi/DeDust REST APIs instead.

### Wallet key format

Both formats are accepted as `WALLET_PRIVATE_KEY`:
- **24 recovery words** (space-separated) — from Tonkeeper, Tonhub, MyTonWallet, etc.
- **64-char hex seed** — raw 32-byte ed25519 seed

## Disclaimer

This software is provided as-is. Not financial advice. Trading digital assets involves risk, including possible loss of funds. Pool commissions, price impact, network gas, and other transactions happening in parallel can all affect the final outcome. The tool simulates rates and picks the best available option, but cannot guarantee the exact output. Use at your own risk.

## License

MIT -- Ask The Ocean
