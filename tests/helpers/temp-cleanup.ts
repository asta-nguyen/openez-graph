import fs from "node:fs";

/**
 * Windows-safe temp dir removal. SQLite `-wal`/`-shm` handles can stay
 * locked until GC even after `Database.close()` on Windows, so a plain
 * `rmSync` there intermittently throws EBUSY. Force a GC pass, retry the
 * removal, and tolerate a residual EBUSY on Windows only — CI runner temp
 * dirs are disposable. Other platforms still surface real cleanup errors.
 */
export function rmTempDir(dir: string): void {
  const global = globalThis as { gc?: (expose?: boolean) => void };
  if (process.platform === "win32" && typeof global.gc === "function") {
    try {
      global.gc(true);
    } catch {
      // GC flag not enabled — fall through to plain rm.
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EBUSY") {
      return;
    }
    throw error;
  }
}
