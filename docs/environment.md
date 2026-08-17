# Environment setup

This guide configures SpotPilot on HiveOS/Linux or Windows. SpotPilot reads a
`.env` file from the **current working directory** every time the CLI starts.
Operating-system environment variables override values from `.env`.

API credentials should be stored in `.env`, not passed as command-line
arguments. Create dedicated exchange credentials with spot-trading permission
only and disable withdrawals.

## Prerequisites

- Node.js 20 or newer
- npm
- a local checkout or extracted copy of this repository
- an API key and secret for each exchange whose private endpoints you use

Check the installed versions:

```text
node --version
npm --version
```

The Node.js version must start with `v20` or a newer major version. If Node.js
is missing or too old, install a current LTS release from the
[official Node.js download page](https://nodejs.org/en/download). Do not assume
that an older Linux distribution's default `nodejs` package satisfies the
version requirement.

## HiveOS and Linux

Open a terminal, change to the SpotPilot directory and install its dependency:

```bash
cd /path/to/spotpilot
npm install
```

Create the local configuration from the tracked example:

```bash
cp .env.example .env
nano .env
```

Save the file in `nano` with `Ctrl+O`, press `Enter`, then exit with `Ctrl+X`.
Restrict the file so only its owner can read or modify it:

```bash
chmod 600 .env
```

Verify that SpotPilot starts from this directory:

```bash
node spotpilot --help
npm run check
npm test
```

The public smoke tests verify Node.js, DNS and exchange connectivity without
submitting an order:

```bash
npm run smoke:coinex
npm run smoke:safetrade
```

### HiveOS and cron working directory

SpotPilot looks for `.env` in the process's current working directory. A cron
job or HiveOS command must therefore change to the repository before starting
the CLI. For example:

```cron
0 12 * * * cd /path/to/spotpilot && /usr/bin/node ./spotpilot balance --exchange coinex --coin BTC >> /var/log/spotpilot.log 2>&1
```

Confirm the actual Node.js path before using it in cron:

```bash
command -v node
```

Avoid placing API keys directly in a crontab or HiveOS flight sheet command.

## Windows

Install Node.js 20 or newer, then open a new PowerShell window so the `node` and
`npm` commands are available. Change to the extracted or cloned repository:

```powershell
Set-Location C:\path\to\spotpilot
npm install
```

Create and edit the configuration file:

```powershell
Copy-Item .env.example .env
notepad .env
```

Keep the repository in your Windows user directory rather than a shared or
cloud-synchronized folder. `.env` is ignored by Git, but it is still a normal
local file and must not be emailed, uploaded or committed.

Verify the installation from the repository directory:

```powershell
node .\spotpilot --help
npm run check
npm test
npm run smoke:coinex
```

PowerShell variables can temporarily override `.env` for the current terminal:

```powershell
$env:SPOTPILOT_EXCHANGE = "coinex"
node .\spotpilot price --pair BTC-USDT
```

Do not use `setx` for exchange secrets. It stores them persistently in the
Windows user environment and only affects newly opened processes.

### Windows Task Scheduler working directory

When creating a scheduled task, configure these fields:

| Task Scheduler field | Value |
| --- | --- |
| Program/script | `C:\Program Files\nodejs\node.exe` |
| Add arguments | `C:\path\to\spotpilot\spotpilot` followed by the command and its options |
| Start in | `C:\path\to\spotpilot` |

Do not put quotes in **Start in**. Setting it to the repository directory is
required for SpotPilot to find `.env`. Use an absolute path for the script and
test the exact command interactively before scheduling it.

## Configure `.env`

Choose a default exchange and add credentials for the exchange you use. A
minimal CoinEx configuration looks like this:

```dotenv
SPOTPILOT_EXCHANGE=coinex
SPOTPILOT_DNS_RESULT_ORDER=ipv4first

COINEX_API_KEY=replace-with-a-trading-only-access-id
COINEX_API_SECRET=replace-with-the-secret-key
```

A minimal SafeTrade configuration looks like this:

```dotenv
SPOTPILOT_EXCHANGE=safetrade
SPOTPILOT_DNS_RESULT_ORDER=ipv4first

SAFETRADE_API_KEY=replace-with-a-trading-only-api-key
SAFETRADE_API_SECRET=replace-with-the-api-secret
```

You may keep credentials for both exchanges in the same file and select one
with `--exchange safetrade|coinex` per command. The command-line option takes
precedence over `SPOTPILOT_EXCHANGE`.

The `.env` syntax is one `NAME=value` entry per line. Comments must start on
their own line with `#`. Do not add `export` before variable names. Single- or
double-quoted values are accepted, although ordinary API credentials usually
do not need quotes.

## Environment variable reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `SPOTPILOT_EXCHANGE` | No | Default exchange: `safetrade` or `coinex`; defaults to `safetrade` |
| `SPOTPILOT_DNS_RESULT_ORDER` | No | DNS preference: `ipv4first`, `ipv6first` or `verbatim`; defaults to `ipv4first` |
| `SPOTPILOT_PROXY_URL` | No | Global HTTP(S) forward proxy used for every exchange request |
| `SPOTPILOT_BUY_RESERVE_PERCENT` | No | Quote-balance reserve for percentage-sized buys; defaults to `0.5` |
| `SPOTPILOT_TIMEOUT_MS` | No | Shared positive integer request timeout in milliseconds; defaults to `15000` |
| `SAFETRADE_API_KEY` | Private SafeTrade calls | SafeTrade trading API key |
| `SAFETRADE_API_SECRET` | Private SafeTrade calls | SafeTrade API secret |
| `SAFETRADE_BASE_URL` | No | SafeTrade API base URL override |
| `SAFETRADE_TIMEOUT_MS` | No | SafeTrade-specific timeout when the shared timeout is unset |
| `COINEX_API_KEY` | Private CoinEx calls | CoinEx access ID |
| `COINEX_API_SECRET` | Private CoinEx calls | CoinEx secret key |
| `COINEX_BASE_URL` | No | CoinEx API base URL override |
| `COINEX_TIMEOUT_MS` | No | CoinEx-specific timeout when the shared timeout is unset |
| `COINEX_WINDOW_TIME_MS` | No | CoinEx request validity window; defaults to `5000` |

Leave `SPOTPILOT_PROXY_URL` unset or empty for a direct connection. If a proxy
is needed, use one of these forms:

```dotenv
SPOTPILOT_PROXY_URL=http://proxy.example.com:3128
SPOTPILOT_PROXY_URL=https://username:password@proxy.example.com:8443
```

URL-encode special characters in proxy usernames or passwords. See the
[proxy setup guide](proxy.md) before operating a shared proxy.

## Verify private API access safely

Start with a read-only balance request for the configured exchange:

```bash
node spotpilot balance --exchange coinex --coin BTC,USDT
```

On Windows PowerShell, use `node .\spotpilot` instead. Before submitting a real
order, run the intended command with `--dryrun`. A dryrun performs private
read-only calls and local validation but does not submit the order:

```bash
node spotpilot order --exchange coinex --type market --side sell --pair BTC-USDT --amount 0.001 --dryrun
```

Use an amount that is available in the account. After validating the output,
test the smallest real order permitted by the selected exchange.

## Troubleshooting

### SpotPilot does not see `.env`

Check the current directory and confirm that `.env` exists there:

```bash
pwd
ls -la .env
```

In PowerShell:

```powershell
Get-Location
Get-Item .env
```

Also check whether an operating-system environment variable is overriding the
same `.env` entry.

### Private calls report missing credentials

Confirm that the credentials match the exchange selected by `--exchange` or
`SPOTPILOT_EXCHANGE`, and that each entry uses the exact `NAME=value` syntax.
The price command is public, so a successful price lookup does not prove that
private credentials are configured correctly.

### SafeTrade returns HTTP 403

SpotPilot prefers IPv4 by default, but SafeTrade may still require the public
outbound IP address to be allowlisted. Run the SafeTrade smoke test with
`--debug`, confirm the host's public IPv4 address and contact SafeTrade support
if the request is blocked. A configured global proxy can provide a stable
outbound address.
