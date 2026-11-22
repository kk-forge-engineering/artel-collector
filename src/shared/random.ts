/**
 * Gives random bytes. The collector makes its queue, lease, session and install ids through this port, so that it reads
 * no host API itself.
 */
export interface Random {
  /** Returns `count` random bytes. */
  bytes(count: number): Uint8Array;
}

/** Returns `byteCount` random bytes, 8 by default, as lowercase hex. */
export function newRandomId(random: Random, byteCount = 8): string {
  return Array.from(random.bytes(byteCount), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
