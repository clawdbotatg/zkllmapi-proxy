import { readFileSync, writeFileSync, existsSync } from "fs";

export interface Credit {
  nullifier: string;   // decimal string bigint
  secret: string;      // decimal string bigint
  commitment: string;  // decimal string bigint
  spent: boolean;
}

const CREDITS_FILE = "credits.json";

export function loadCredits(): Credit[] {
  if (!existsSync(CREDITS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(CREDITS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

export function saveCredits(credits: Credit[]): void {
  writeFileSync(CREDITS_FILE, JSON.stringify(credits, null, 2));
}

export function getUnspentCredits(credits: Credit[]): Credit[] {
  return credits.filter(c => !c.spent);
}

export function markSpent(credits: Credit[], commitment: string): Credit[] {
  return credits.map(c =>
    c.commitment === commitment ? { ...c, spent: true } : c
  );
}
