/**
 * chat.ts — Interactive E2EE CLI chat for zkllmapi
 *
 * Usage:
 *   pnpm chat              # interactive chat
 *   pnpm chat --buy        # buy 10 credits, show status, exit
 *   pnpm chat --health     # show proxy health
 *
 * No proxy required — this CLI generates ZK proofs + E2EE encrypts directly.
 * Run the proxy separately for auto-refill + pre-warming (pnpm start).
 */

import { createInterface } from "readline";
import { encryptChatRequest } from "./e2ee.js";
import { generateProof, popProof, queueDepth } from "./prove.js";
import { loadCredits, saveCredits } from "./credits.js";

const MODEL = "zai-org-glm-5";
const API_URL = "https://backend.zkllmapi.com";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const history: { role: "user" | "assistant"; content: string }[] = [];

function prompt(question: string): Promise<string> {
  return new Promise((res) => rl.question(question, res));
}

async function waitForProof(): Promise<void> {
  // First check if a proof is already pre-warmed by the proxy
  let proof = popProof();
  if (proof) return;

  // Need to generate a proof from scratch
  const credits = loadCredits();
  const credit = credits.find((c) => !c.spent);
  if (!credit) {
    console.error("\n❌ No unspent credits. Run `pnpm chat --buy` first.\n");
    process.exit(1);
  }

  process.stdout.write(`\n⏳ No pre-warmed proofs. Generating ZK proof (30-60s)...\n`);
  process.stdout.write(`   Commitment: ${credit.commitment.slice(0, 20)}...\n`);

  try {
    await generateProof(credit);
    proof = popProof();
  } catch (err: any) {
    if (err.message.includes("not found in tree")) {
      throw new Error(
        "Commitment not indexed yet — wait for on-chain sync (~30s after buy), or run the proxy to auto pre-warm."
      );
    }
    throw err;
  }
}

async function sendMessage(
  messages: { role: "user" | "assistant"; content: string }[],
  stream = true
): Promise<string> {
  await waitForProof();
  const proof = popProof()!;

  // E2EE encrypt the messages
  const reqBody = { messages, model: MODEL, stream };
  const { encryptedBody, e2eeHeaders } = await encryptChatRequest(reqBody, MODEL);

  // Build final request body with proof + encrypted payload
  const body = {
    ...encryptedBody,
    proof: proof.proofHex,
    publicInputs: proof.publicInputs,
    nullifier_hash: proof.nullifierHashHex,
    root: proof.rootHex,
    depth: proof.depth,
  };

  const headers = { "Content-Type": "application/json", ...e2eeHeaders };

  const response = await fetch(`${API_URL}/v1/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`API error ${response.status}: ${err}`);
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let fullContent = "";

    process.stdout.write("\n🧠 ");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      fullContent += chunk;
      process.stdout.write(chunk);
    }
    process.stdout.write("\n\n");
    return fullContent;
  } else {
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    console.log("\n🧠", content, "\n");
    return content;
  }
}

async function markCreditSpent(): Promise<void> {
  const credits = loadCredits();
  const credit = credits.find((c) => !c.spent);
  if (credit) {
    credit.spent = true;
    saveCredits(credits);
  }
}

async function showHealth(): Promise<void> {
  const PROXY_URL = process.env.PROXY_URL ?? "http://localhost:3100";
  try {
    const res = await fetch(`${PROXY_URL}/health`);
    const h = await res.json();
    console.log(`\n📊 Proxy Health`);
    console.log(`   Wallet:   ${h.wallet}`);
    console.log(`   Credits:  ${h.credits.unspent} unspent / ${h.credits.total} total`);
    console.log(`   Proof q:  ${h.proofQueue} ready`);
    console.log(`   Thresholds: buy when ≤${h.thresholds.buyThreshold}, buy ${h.thresholds.buyChunk} at a time\n`);
  } catch (e: any) {
    // Proxy not running — show local credit status instead
    const credits = loadCredits();
    const unspent = credits.filter((c) => !c.spent);
    console.log(`\n📊 Local Status (proxy not running)`);
    console.log(`   Credits:  ${unspent.length} unspent / ${credits.length} total`);
    console.log(`   Proof q:  ${queueDepth()} pre-warmed\n`);
  }
}

async function runChat(): Promise<void> {
  console.clear();
  console.log("🔐 zkllmapi — E2EE anonymous chat (GLM-5 in Venice TEE)");
  console.log(`   Backend:  ${API_URL}`);
  console.log(`   Model:    ${MODEL}`);
  console.log("   Type '/quit' to exit, '/history' to see conversation\n");

  const credits = loadCredits();
  const unspent = credits.filter((c) => !c.spent);
  console.log(`   💳 ${unspent.length} unspent credits | ${queueDepth()} proofs pre-warmed\n`);

  if (unspent.length === 0) {
    console.log("   ⚠️  No credits! Run `pnpm chat --buy` first.\n");
  }

  while (true) {
    const input = await prompt("👤 you: ");
    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed === "/quit" || trimmed === "/q") {
      rl.close();
      break;
    }
    if (trimmed === "/history" || trimmed === "/h") {
      for (const msg of history) {
        const label = msg.role === "user" ? "👤 you" : "🧠 bot";
        console.log(`\n${label}: ${msg.content.slice(0, 300)}`);
      }
      console.log();
      continue;
    }
    if (trimmed === "/health" || trimmed === "/s") {
      await showHealth();
      continue;
    }

    history.push({ role: "user", content: trimmed });

    try {
      const response = await sendMessage(history, true);

      // Parse streamed SSE to extract text for history
      const textContent = response
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => {
          try {
            const obj = JSON.parse(l.slice(6));
            return obj.choices?.[0]?.delta?.content ?? "";
          } catch { return ""; }
        })
        .join("");

      history.push({ role: "assistant", content: textContent });
      await markCreditSpent();

      const remaining = loadCredits().filter((c) => !c.spent);
      console.log(`   💳 ${remaining.length} credits remaining\n`);
    } catch (e: any) {
      console.error("\n❌ Error:", e.message, "\n");
      history.pop(); // remove failed user message
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--health") || args.includes("-s")) {
    await showHealth();
    process.exit(0);
  }

  if (args.includes("--buy") || args.includes("-b")) {
    const n = parseInt(args.find((a) => /^\d+$/.test(a)) ?? "10", 10);
    console.log(`Buying ${n} credits...`);
    const { buyCredits } = await import("./buy.js");
    const newCredits = await buyCredits(n);
    console.log(`✅ Bought ${newCredits.length} credits`);
    // Append to credits.json
    const existing = loadCredits();
    saveCredits([...existing, ...newCredits]);
    await showHealth();
    process.exit(0);
  }

  await runChat();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
