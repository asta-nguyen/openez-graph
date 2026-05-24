import { resolveRegistryDbPath } from "../server/sqlite";

export type RegistryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; dbPath: string };

export function getRegistryDbPath(): string {
  try {
    return resolveRegistryDbPath();
  } catch {
    return "unknown";
  }
}

export async function withRegistry<T>(fn: () => Promise<T>): Promise<RegistryResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const dbPath = getRegistryDbPath();
    console.error(`[registry-access] ${message}`);
    return { ok: false, error: message, dbPath };
  }
}
