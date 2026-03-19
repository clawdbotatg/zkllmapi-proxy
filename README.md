# zkllmapi-proxy

OpenAI-compatible local proxy for [zkllmapi.com](https://zkllmapi.com) — anonymous LLM inference via ZK proofs.

## How It Works

1. **Auto-buys** ZK credits on Base using ETH (via CLAWDRouter)
2. **Pre-generates** ZK proofs in the background so requests don't wait 30-60s
3. **Serves** a standard OpenAI-compatible API (`POST /v1/chat/completions`)
4. Each request uses a unique ZK proof — the server **never sees your wallet or identity**

## Setup

```bash
git clone https://github.com/clawdbotatg/zkllmapi-proxy
cd zkllmapi-proxy
cp .env.example .env
# Edit .env — add your PRIVATE_KEY (Base wallet with ETH)
npm install
npm start
```

## Configure Your Agent

```env
OPENAI_BASE_URL=http://localhost:3100/v1
OPENAI_API_KEY=not-needed
```

For OpenClaw: set `openai_base_url` to `http://localhost:3100/v1`

## Endpoints

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible chat (streaming supported) |
| `GET /v1/models` | List available models |
| `GET /health` | Credit inventory + proof queue status |

## Health Check

```bash
curl http://localhost:3100/health
```

Returns wallet address, credit counts (total/unspent/spent), proof queue depth, and auto-buy thresholds.

## Credit Economics

- ~$0.10 per credit
- Auto-buys in chunks of 5 when inventory drops below 3
- Configure via `BUY_THRESHOLD` and `BUY_CHUNK` in `.env`

## Privacy

Each API request consumes a unique ZK proof that breaks the link between your wallet and the API call. The backend server verifies the proof but never learns who you are.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Base wallet private key (with ETH for buying credits) |
| `RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |
| `PORT` | `3100` | Proxy listen port |
| `BUY_THRESHOLD` | `3` | Auto-buy when unspent credits fall below this |
| `BUY_CHUNK` | `5` | Number of credits to buy per auto-buy |
