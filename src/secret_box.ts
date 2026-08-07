import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Sealed secret wire format: enc:v1:<b64(iv)>.<b64(tag)>.<b64(ciphertext)> */
const SEAL_PREFIX = "enc:v1:";
const KEY_FILENAME = "secrets.key";
const SCRYPT_SALT = Buffer.from("writer-agent-secret-box-v1", "utf8");

export function isSealedSecret(value: string): boolean {
  return typeof value === "string" && value.startsWith(SEAL_PREFIX);
}

/**
 * Load or create a project-local 32-byte master key (mode 0600).
 * Override with WRITER_SECRETS_KEY (hex 64 chars or any passphrase).
 */
export function loadOrCreateProjectSecretKey(privateDir: string): Buffer {
  const env = process.env.WRITER_SECRETS_KEY?.trim();
  if (env) {
    if (/^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, "hex");
    return scryptSync(env, SCRYPT_SALT, 32);
  }
  const path = resolve(privateDir, KEY_FILENAME);
  if (existsSync(path)) {
    const raw = readFileSync(path);
    if (raw.length === 32) return raw;
    if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw.toString("utf8").trim())) {
      return Buffer.from(raw.toString("utf8").trim(), "hex");
    }
    // Legacy/corrupt key file: re-derive a stable key from its bytes so existing
    // seals remain openable when the file is unchanged.
    return scryptSync(raw, SCRYPT_SALT, 32);
  }
  mkdirSync(privateDir, { recursive: true });
  const key = randomBytes(32);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, key, { mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch {
    writeFileSync(path, key, { mode: 0o600 });
    try { writeFileSync(temporary, Buffer.alloc(0)); } catch { /* ignore */ }
  }
  return key;
}

export function sealSecret(plaintext: string, key: Buffer): string {
  if (!plaintext) return "";
  if (isSealedSecret(plaintext)) return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SEAL_PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function openSecret(value: string, key: Buffer): string {
  if (!value) return "";
  if (!isSealedSecret(value)) return value;
  const body = value.slice(SEAL_PREFIX.length);
  const [ivPart, tagPart, dataPart] = body.split(".");
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error("密文格式无效");
  }
  const iv = Buffer.from(ivPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");
  const data = Buffer.from(dataPart, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Decrypt if sealed; leave plaintext unchanged. Never throws on plain values. */
export function openSecretLoose(value: string, key: Buffer): string {
  if (!isSealedSecret(value)) return value;
  try {
    return openSecret(value, key);
  } catch {
    throw new Error("无法解密 API Key：secrets.key 或 WRITER_SECRETS_KEY 与写入时不一致");
  }
}

export const PROJECT_SECRETS_KEY_FILENAME = KEY_FILENAME;
