import "dotenv/config";
import express from "express";
import cors from "cors";
import { PORT, BUY_THRESHOLD, BUY_CHUNK } from "./config.js";
import { loadCredits, saveCredits, markSpent, getUnspentCredits } from "./credits.js";
import { preWarm, popProof, queueDepth, checkAndBuy } from "./prove.js";
import { callZkApi, buildOpenAIResponse, streamResponse } from "./adapter.js";
import { encryptChatRequest, decryptChatResponse, getE2EESession, isE2EEModel, DEFAULT_E2EE_MODEL } from "./e2ee.js";
import { privateKeyToAccount } from "viem/accounts";
import { getPrivateKey } from "./config.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const MODEL = "hermes-3-llama-3.1-405b";

// In-memory credit state
let credits = loadCredits();

function persistCredits() {
  saveCredits(credits);
}

// ─── GET /v1/models ───────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [{ id: MODEL, object: "model", owned_by: "zkllmapi" }],
  });
});

// ─── GET /health ──────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const unspent = getUnspentCredits(credits);
  res.json({
    status: "ok",
    wallet: privateKeyToAccount(getPrivateKey()).address,
    credits: {
      total: credits.length,
      unspent: unspent.length,
      spent: credits.length - unspent.length,
    },
    proofQueue: queueDepth(),
    thresholds: { buyThreshold: BUY_THRESHOLD, buyChunk: BUY_CHUNK },
  });
});

// ─── POST /v1/chat/completions ────────────────────────────────
app.post("/v1/chat/completions", async (req, res) => {
  const { messages, stream = false, model: requestedModel } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: { message: "messages is required", type: "invalid_request_error" } });
    return;
  }

  // Determine if E2EE mode is requested
  const e2eeMode = requestedModel ? isE2EEModel(requestedModel) : false;
  const targetModel = requestedModel ?? MODEL;

  // Get a ready proof
  let proof = popProof();

  if (!proof) {
    const unspent = getUnspentCredits(credits);
    if (unspent.length === 0) {
      res.status(503).json({
        error: {
          message: "No credits available. Proxy is buying more — try again in ~30 seconds.",
          type: "service_unavailable",
        },
      });
      checkAndBuy(() => credits, (newCredits) => {
        credits = [...credits, ...newCredits];
        persistCredits();
      }).catch(console.error);
      return;
    }

    console.log("[proxy] no pre-warmed proof available — generating on demand (slow)...");
    const { generateProof } = await import("./prove.js");
    try {
      proof = await generateProof(unspent[0]);
    } catch (err: any) {
      res.status(500).json({ error: { message: `Proof generation failed: ${err.message}`, type: "server_error" } });
      return;
    }
  }

  console.log(`[proxy] using proof for commitment ${proof.commitment.slice(0, 12)}... ${e2eeMode ? "[E2EE 🔒]" : ""}`);

  // E2EE: encrypt messages before sending to our server
  let callOptions: Parameters<typeof callZkApi>[3] = { model: targetModel };
  if (e2eeMode) {
    try {
      const { encryptedBody, e2eeHeaders } = await encryptChatRequest(req.body, targetModel);
      callOptions = {
        model: targetModel,
        encryptedMessages: encryptedBody.encrypted_messages,
        e2eeHeaders,
      };
      console.log(`[e2ee] messages encrypted, client pubkey: ${callOptions.e2eeHeaders!["X-Venice-TEE-Client-Pub-Key"].slice(0, 16)}...`);
    } catch (err: any) {
      res.status(502).json({ error: { message: `E2EE setup failed: ${err.message}`, type: "server_error" } });
      return;
    }
  }

  let zkResponse: Response;
  try {
    zkResponse = await callZkApi(proof, messages, stream, callOptions);
  } catch (err: any) {
    res.status(502).json({ error: { message: `ZK API unreachable: ${err.message}`, type: "server_error" } });
    return;
  }

  if (!zkResponse.ok) {
    const errBody = await zkResponse.json().catch(() => ({}));
    res.status(zkResponse.status).json({
      error: { message: (errBody as any).error ?? "ZK API error", type: "server_error" },
    });
    return;
  }

  // Mark credit spent
  credits = markSpent(credits, proof.commitment);
  persistCredits();

  // Trigger background replenishment (waitForIndexing is inside checkAndBuy)
  checkAndBuy(() => credits, (newCredits) => {
    credits = [...credits, ...newCredits];
    persistCredits();
  }).catch(console.error);

  if (stream) {
    await streamResponse(zkResponse, res, targetModel);
  } else {
    let data = await zkResponse.json();
    // E2EE: decrypt response if needed
    if (e2eeMode) {
      try {
        const session = await getE2EESession(targetModel);
        data = decryptChatResponse(data, session);
        console.log(`[e2ee] response decrypted ✅`);
      } catch (err: any) {
        console.error(`[e2ee] response decryption failed:`, err.message);
        // Still return whatever we got — let caller decide
      }
    }
    res.json(buildOpenAIResponse(data, targetModel));
  }
});

// ─── Startup ──────────────────────────────────────────────────
async function startup() {
  const account = privateKeyToAccount(getPrivateKey());
  console.log(`🔐 zkllmapi-proxy starting...`);
  console.log(`   Wallet: ${account.address}`);
  console.log(`   Credits loaded: ${credits.length} total, ${getUnspentCredits(credits).length} unspent`);
  console.log(`   Auto-buy: when < ${BUY_THRESHOLD} unspent, buy ${BUY_CHUNK}`);

  await checkAndBuy(() => credits, (newCredits) => {
    credits = [...credits, ...newCredits];
    persistCredits();
  });

  const unspent = getUnspentCredits(credits);
  if (unspent.length > 0) {
    console.log(`[startup] pre-warming proofs for ${unspent.length} credits in background...`);
    preWarm(unspent).catch(console.error);
  }

  app.listen(PORT, () => {
    console.log(`\n✅ Proxy listening on http://localhost:${PORT}`);
    console.log(`   OpenAI base URL: http://localhost:${PORT}/v1`);
    console.log(`   Point your agent at: http://localhost:${PORT}`);
  });
}

startup().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
