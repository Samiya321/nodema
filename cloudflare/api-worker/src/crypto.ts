import { timingSafeEqual } from "node:crypto";

const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const buffer = (value: Uint8Array): ArrayBuffer =>
  Uint8Array.from(value).buffer;
function join(...values: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(values.reduce((n, v) => n + v.length, 0));
  let offset = 0;
  for (const v of values) {
    out.set(v, offset);
    offset += v.length;
  }
  return out;
}
export class SafeError extends Error {
  constructor(
    public code: string,
    public status = 400,
  ) {
    super(code);
  }
}
export async function equal(a: string, b: string): Promise<boolean> {
  const hashes = await Promise.all(
    [a, b].map((v) =>
      crypto.subtle.digest("SHA-256", buffer(encoder.encode(v))),
    ),
  );
  return timingSafeEqual(new Uint8Array(hashes[0]), new Uint8Array(hashes[1]));
}
export async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", buffer(encoder.encode(value))),
  );
}
export function token(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
}
export class Cipher {
  private header: Uint8Array;
  private key: Promise<CryptoKey>;
  constructor(encoded: string, id: string) {
    const raw = Buffer.from(encoded, "base64");
    if (raw.length !== 32 || !/^[A-Za-z0-9_-]{1,32}$/.test(id))
      throw new SafeError("INVALID_KEYS", 503);
    const kid = encoder.encode(id);
    this.header = join(encoder.encode("NMA1"), Uint8Array.of(kid.length), kid);
    this.key = crypto.subtle.importKey("raw", buffer(raw), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
  async encrypt(value: string, context: string): Promise<Buffer> {
    const nonce = crypto.getRandomValues(new Uint8Array(12)),
      aad = join(this.header, Uint8Array.of(0), encoder.encode(context));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: buffer(nonce),
        additionalData: buffer(aad),
        tagLength: 128,
      },
      await this.key,
      buffer(encoder.encode(value)),
    );
    return Buffer.from(join(this.header, nonce, new Uint8Array(encrypted)));
  }
  async decrypt(value: Uint8Array, context: string): Promise<string> {
    try {
      const size = value[4],
        header = value.slice(0, 5 + size);
      if (
        size < 1 ||
        size > 32 ||
        !timingSafeEqual(Buffer.from(header), Buffer.from(this.header))
      )
        throw new Error();
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: buffer(value.slice(5 + size, 17 + size)),
          additionalData: buffer(
            join(header, Uint8Array.of(0), encoder.encode(context)),
          ),
          tagLength: 128,
        },
        await this.key,
        buffer(value.slice(17 + size)),
      );
      return decoder.decode(plain);
    } catch {
      throw new SafeError("DECRYPTION_FAILED", 500);
    }
  }
}
