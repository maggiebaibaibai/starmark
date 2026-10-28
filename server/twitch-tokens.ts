import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Tokens {
  access: string;
  refresh: string;
  expiresAt: number;
  userId: string;
}
/** Encryption at rest; the key is derived from the app secret, which never enters data/. */
export class TokenVault {
  private key: Buffer;
  private file: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private root: string, secret: string, private identity: string) {
    this.key = createHash("sha256").update(secret).digest();
    this.file = join(root, "twitch-tokens.json");
  }
  private run<T>(action: () => Promise<T>) {
    const result = this.pending.then(action);
    this.pending = result.catch(() => {});
    return result;
  }
  load(): Promise<Tokens | undefined> {
    return this.run(async () => {
      let raw: string;
      try { raw = await readFile(this.file, "utf8"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error("Saved Twitch authorization could not be read");
      }
      try {
        const { iv, tag, ciphertext } = JSON.parse(raw);
        const cipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
        cipher.setAAD(Buffer.from(this.identity));
        cipher.setAuthTag(Buffer.from(tag, "base64"));
        const tokens = JSON.parse(Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64")), cipher.final()]).toString()) as Tokens;
        if (!tokens.access || !tokens.refresh || !tokens.userId || !Number.isFinite(tokens.expiresAt)) throw new Error();
        return tokens;
      } catch { throw new Error("Saved Twitch authorization is invalid; connect again"); }
    });
  }
  save(tokens: Tokens) {
    return this.run(async () => {
      try {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(Buffer.from(this.identity));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]);
        const value = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
        await writeFile(this.file + ".tmp", JSON.stringify(value), { mode: 0o600 });
        await rename(this.file + ".tmp", this.file);
      } catch { throw new Error("Twitch authorization could not be saved"); }
    });
  }
  delete() {
    return this.run(async () => {
      try {
        await rm(this.file, { force: true });
        await rm(this.file + ".tmp", { force: true });
      } catch { throw new Error("Saved Twitch authorization could not be deleted"); }
    });
  }
}
