export type ArgMap = Record<string, string | boolean>;

import fs from "node:fs";
import path from "node:path";

export function loadDotEnv(): void {
  // Minimal .env loader (no dependency).
  // - Loads from "<repoRoot>/.env"
  // - Does NOT overwrite existing process.env values
  // - Supports lines like KEY=value (quotes optional), ignores comments and blanks
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;

    // Support: export KEY=VALUE
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;

    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;

    const key = normalized.slice(0, eq).trim();
    let val = normalized.slice(eq + 1).trim();
    if (!key) continue;

    // Strip matching quotes
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

export function parseArgs(argv: string[]): ArgMap {
  // Minimal parser:
  // - supports: --key value, --flag
  // - ignores: positional args
  const args: ArgMap = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i++;
  }
  return args;
}

export function getArg(args: ArgMap, key: string, fallback?: string): string | undefined {
  const v = args[key];
  if (typeof v === "string") return v;
  return fallback;
}

export function getFlag(args: ArgMap, key: string): boolean {
  return args[key] === true;
}

export function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing env var ${name}. Add it to your .env (or export it).`);
  }
  return v;
}

export function normalizePk(pk: string): string {
  return pk.startsWith("0x") ? pk : `0x${pk}`;
}
