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

function getMasterKey(): Buffer {
  if (cachedKey) return cachedKey;

  const dir = path.dirname(MASTER_KEY_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }

  if (fs.existsSync(MASTER_KEY_FILE)) {
    cachedKey = Buffer.from(fs.readFileSync(MASTER_KEY_FILE, "utf-8").trim(), "hex");
    if (cachedKey.length === KEY_LEN) return cachedKey;
  }

  // Generate new key
  cachedKey = crypto.randomBytes(KEY_LEN);
  fs.writeFileSync(MASTER_KEY_FILE, cachedKey.toString("hex"), { encoding: "utf-8", mode: 0o600 });
  return cachedKey;
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
