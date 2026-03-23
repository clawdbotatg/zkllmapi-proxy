# zkllmapi-proxy

OpenAI-compatible local proxy for [zkllmapi.com](https://zkllmapi.com) — anonymous LLM inference via ZK proofs with end-to-end encryption.

## How It Works

1. **Auto-buys** ZK credits on Base (buys 10 when inventory drops to ≤5)
2. **Pre-generates** ZK proofs in the background so requests don't wait 30-60s
3. **E2EE** — messages encrypted to Venice TEE via ECDH + AES-256-GCM; proxy never sees plaintext
4. **Serves** a standard OpenAI-compatible API (`POST /v1/chat/completions`)
5. Each request uses a unique ZK proof — the server **never sees your wallet or identity**

## Setup

```bash
cd zkllmapi-proxy
cp .env.example .env
# Edit .env — add your PRIVATE_KEY (Base wallet with ETH)
npm install
npm start        # start proxy (auto-buy + proof pre-warming)
npm run chat     # interactive E2EE chat CLI
```

## Interactive Chat CLI

```bash
npm run chat           # start interactive chat (zai-org-glm-5 in Venice TEE)
npm run chat -- --buy  # buy 10 credits, then start chat
npm run chat -- --health  # show credit inventory + queue status
```

Commands inside chat:
- `/quit` or `/q` — exit
- `/history` or `/h` — show conversation history
- `/health` or `/s` — show proxy status

## Configure Your Agent / OpenClaw

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

## Privacy

Each API request consumes a unique ZK proof that breaks the link between your wallet and the API call. Messages are E2EE — the proxy encrypts them to Venice's TEE before forwarding. The backend server verifies the proof but never learns who you are or what you said.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Base wallet private key (with ETH for buying credits) |
| `RPC_URL` | `https://mainnet.base.org` | Base RPC endpoint |
| `PORT` | `3100` | Proxy listen port |
| `BUY_THRESHOLD` | `5` | Auto-buy when unspent credits fall below this |
| `BUY_CHUNK` | `10` | Number of credits to buy per auto-buy (batch insert) |
