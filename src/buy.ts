import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Barretenberg, Fr } from "@aztec/bb.js";
import {
  CONTRACTS, ROUTER_ABI, PRICING_ABI, APICREDITS_ABI,
  getPrivateKey, getRpcUrl,
} from "./config.js";
import type { Credit } from "./credits.js";

function randomField(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

export async function buyCredits(count: number): Promise<Credit[]> {
  const account = privateKeyToAccount(getPrivateKey());
  const transport = http(getRpcUrl());
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ chain: base, transport, account });

  console.log(`[buy] Wallet: ${account.address}`);
  console.log(`[buy] Buying ${count} credit(s) in one transaction...`);

  // Generate nullifier + secret for each credit
  const bb = await Barretenberg.new({ threads: 1 });
  const newCredits: { nullifier: bigint; secret: bigint; commitment: bigint }[] = [];

  console.log("[buy] Computing commitments (poseidon2)...");
  for (let i = 0; i < count; i++) {
    const nullifier = randomField();
    const secret = randomField();
    const commitmentFr = await bb.poseidon2Hash([new Fr(nullifier), new Fr(secret)]);
    const commitment = BigInt("0x" + Buffer.from(commitmentFr.value).toString("hex"));
    newCredits.push({ nullifier, secret, commitment });
    console.log(`  [${i + 1}/${count}] commitment: ${commitment.toString().slice(0, 20)}...`);
  }
  await bb.destroy();

  // Quote ETH cost
  console.log("[buy] Fetching pricing...");
  const oracleData = await publicClient.readContract({
    address: CONTRACTS.CLAWDPricing,
    abi: PRICING_ABI,
    functionName: "getOracleData",
  });

  const [clawdPerEth, , pricePerCreditCLAWD] = oracleData;
  const ethNeeded = (pricePerCreditCLAWD * BigInt(count) * 125n * 10n ** 18n) / (clawdPerEth * 100n);
  console.log(`[buy] ETH needed for ${count} credits (25% buffer): ${formatEther(ethNeeded)} ETH`);

  const pricePerCredit = await publicClient.readContract({
    address: CONTRACTS.APICredits,
    abi: APICREDITS_ABI,
    functionName: "pricePerCredit",
  });
  const minCLAWDOut = (pricePerCredit * BigInt(count) * 95n) / 100n;

  // Buy all commitments in one tx
  const commitmentArgs = newCredits.map(c => c.commitment);
  console.log("[buy] Sending buyWithETH transaction...");
  const hash = await walletClient.writeContract({
    address: CONTRACTS.CLAWDRouter,
    abi: ROUTER_ABI,
    functionName: "buyWithETH",
    args: [commitmentArgs, minCLAWDOut],
    value: ethNeeded,
  });
  console.log(`[buy] Tx hash: ${hash}`);

  console.log("[buy] Waiting for confirmation...");
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[buy] Confirmed in block ${receipt.blockNumber}`);
  console.log(`[buy] Basescan: https://basescan.org/tx/${hash}`);

  return newCredits.map(c => ({
    nullifier: c.nullifier.toString(),
    secret: c.secret.toString(),
    commitment: c.commitment.toString(),
    spent: false,
  }));
}
