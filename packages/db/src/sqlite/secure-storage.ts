import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MASTER_KEY_FILE = path.join(os.homedir(), ".openez", "master.key");
const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const PREFIX = "enc:";

let cachedKey: Buffer | null = null;

function ensureKeyFilePermissions(filePath: string): void {
  const stat = fs.statSync(filePath);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) {
    fs.chmodSync(filePath, 0o600);
  }
}

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const dir = path.dirname(MASTER_KEY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }

  // Try to read an existing key first.
  let keyExists = false;
  try {
    ensureKeyFilePermissions(MASTER_KEY_FILE);
    const existing = fs.readFileSync(MASTER_KEY_FILE, "utf-8").trim();
    keyExists = true;
    cachedKey = Buffer.from(existing, "hex");
    if (cachedKey.length === KEY_LEN) return cachedKey;
    // File exists but content is malformed — do NOT overwrite, fail explicitly.
    throw new Error(
      `Master key file exists but contains invalid data (expected ${KEY_LEN}-byte hex, got ${existing.length} chars). ` +
        `Back up the file, then delete it only if no encrypted settings need preserving.`,
    );
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // File doesn't exist — legitimate first run, fall through to creation.
    } else if (keyExists) {
      // Already threw an explicit malformed-key error above; re-throw it.
      throw err;
    } else {
      // Other read errors (permissions, I/O) — surface them.
      throw err;
    }
  }

  // Atomically create the key file. O_CREAT|O_EXCL (flag "wx") guarantees
  // only one process wins; concurrent losers get EEXIST and read the winner's key.
  const newKey = crypto.randomBytes(KEY_LEN);
  let fd: number | null = null;
  try {
    fd = fs.openSync(MASTER_KEY_FILE, "wx", 0o600);
    fs.writeFileSync(fd, newKey.toString("hex"), { encoding: "utf-8" });
    cachedKey = newKey;
    return cachedKey;
  } catch (err: unknown) {
    // Another process created the file between our read and our open.
    // Reload the winning key instead of overwriting it.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      ensureKeyFilePermissions(MASTER_KEY_FILE);
      const winner = fs.readFileSync(MASTER_KEY_FILE, "utf-8").trim();
      cachedKey = Buffer.from(winner, "hex");
      if (cachedKey.length === KEY_LEN) return cachedKey;
    }
    throw err;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function encryptValue(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: enc:<hex(iv + tag + encrypted)>
  return PREFIX + Buffer.concat([iv, tag, encrypted]).toString("hex");
}

export function decryptValue(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;

  const key = getMasterKey();
  const raw = Buffer.from(stored.slice(PREFIX.length), "hex");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = raw.subarray(IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf-8");
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

const SENSITIVE_PATTERNS = ["api_key", "secret", "password", "token"];

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}
