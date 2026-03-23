import "dotenv/config";

export function getPrivateKey(): `0x${string}` {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY not set in .env");
  return pk as `0x${string}`;
}

export function getRpcUrl(): string {
  return process.env.RPC_URL ?? "https://mainnet.base.org";
}

export const PORT = parseInt(process.env.PORT ?? "3100", 10);
export const BUY_THRESHOLD = parseInt(process.env.BUY_THRESHOLD ?? "3", 10);
export const BUY_CHUNK = parseInt(process.env.BUY_CHUNK ?? "5", 10);

export const API_URL = "https://backend.zkllmapi.com";

export const CONTRACTS = {
  APICredits:   "0x595463222a592416BCbdADb297Bf7D050c09a44E" as `0x${string}`,
  CLAWDRouter:  "0xCB42c19bB4021C30960c45212E8A9162259ea3E5" as `0x${string}`,
  CLAWDPricing: "0x445DbaFC831940c252CAE3f04e35F9045616Ce19" as `0x${string}`,
  CLAWD:        "0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07" as `0x${string}`,
} as const;

export const ROUTER_ABI = [
  {
    inputs: [
      { name: "commitments", type: "uint256[]" },
      { name: "minCLAWDOut", type: "uint256" },
    ],
    name: "buyWithETH",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export const PRICING_ABI = [
  {
    inputs: [],
    name: "getOracleData",
    outputs: [
      { name: "clawdPerEth", type: "uint256" },
      { name: "ethUsd", type: "uint256" },
      { name: "pricePerCreditCLAWD", type: "uint256" },
      { name: "usdPerCredit", type: "uint256" },
      { name: "clawdUsd", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const APICREDITS_ABI = [
  {
    inputs: [],
    name: "pricePerCredit",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;
