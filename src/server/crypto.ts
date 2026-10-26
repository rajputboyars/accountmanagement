import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 256-bit random token, URL-safe. Used for session tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Uniformly random 6-digit code (000000–999999) from the OS CSPRNG. */
export function randomOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256Hex(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

/** Constant-time comparison of two strings (compares their SHA-256 digests, so lengths may differ). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}
