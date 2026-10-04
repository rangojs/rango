/**
 * rango({ encryptionKey }): where the build's action-encryption key comes
 * from, and that a bad one fails when the config is read rather than on the
 * first encrypted action in production.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertValidEncryptionKey,
  buildEncryptionKey,
  configureEncryptionKey,
  defineEncryptionKeyExpr,
  isEncryptionKeyStable,
  resetEncryptionKeyForTests,
} from "../encryption-key.js";
import { rango } from "../rango.js";

const KEY_32 = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY_32 = Buffer.alloc(32, 9).toString("base64");

describe("encryption key", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.RANGO_ENCRYPTION_KEY;
    delete process.env.RANGO_ENCRYPTION_KEY;
    resetEncryptionKeyForTests();
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.RANGO_ENCRYPTION_KEY;
    else process.env.RANGO_ENCRYPTION_KEY = savedEnv;
    resetEncryptionKeyForTests();
  });

  describe("source order", () => {
    it("uses the option when it is set", () => {
      process.env.RANGO_ENCRYPTION_KEY = OTHER_KEY_32;
      configureEncryptionKey(KEY_32);
      expect(buildEncryptionKey()).toBe(KEY_32);
      expect(isEncryptionKeyStable()).toBe(true);
    });

    it("falls back to RANGO_ENCRYPTION_KEY when the option is undefined", () => {
      process.env.RANGO_ENCRYPTION_KEY = OTHER_KEY_32;
      configureEncryptionKey(undefined);
      expect(buildEncryptionKey()).toBe(OTHER_KEY_32);
      expect(isEncryptionKeyStable()).toBe(true);
    });

    it("generates a 32-byte key, and reports it as not stable, when neither is set", () => {
      configureEncryptionKey(undefined);
      const key = buildEncryptionKey();
      expect(Buffer.from(key, "base64")).toHaveLength(32);
      expect(isEncryptionKeyStable()).toBe(false);
    });

    it("keeps one generated key for the whole process", () => {
      // rango() and the discovery temp server both ask; they must encrypt
      // with the same key.
      configureEncryptionKey(undefined);
      const first = buildEncryptionKey();
      configureEncryptionKey(undefined);
      expect(buildEncryptionKey()).toBe(first);
      expect(defineEncryptionKeyExpr()).toBe(JSON.stringify(first));
    });

    it("resolves lazily from the environment when rango() never ran", () => {
      process.env.RANGO_ENCRYPTION_KEY = KEY_32;
      expect(buildEncryptionKey()).toBe(KEY_32);
    });

    it("lets a later rango() call set a key over a generated one", () => {
      configureEncryptionKey(undefined);
      configureEncryptionKey(KEY_32);
      expect(buildEncryptionKey()).toBe(KEY_32);
      expect(isEncryptionKeyStable()).toBe(true);
    });
  });

  describe("validation", () => {
    it.each([
      ["16 bytes", Buffer.alloc(16, 1).toString("base64")],
      ["24 bytes", Buffer.alloc(24, 1).toString("base64")],
      ["32 bytes", KEY_32],
      ["32 bytes without padding", KEY_32.replace(/=+$/, "")],
    ])("accepts a base64 AES key of %s", (_label, key) => {
      expect(() => assertValidEncryptionKey(key, "the key")).not.toThrow();
    });

    it("rejects an empty string, naming the fix", () => {
      expect(() =>
        assertValidEncryptionKey("", "rango({ encryptionKey })"),
      ).toThrow(
        /rango\(\{ encryptionKey \}\) is an empty string.*openssl rand -base64 32/s,
      );
    });

    it("rejects a value that is not base64", () => {
      expect(() =>
        assertValidEncryptionKey("not base64!!", "RANGO_ENCRYPTION_KEY"),
      ).toThrow(/RANGO_ENCRYPTION_KEY is not valid base64/);
    });

    it("rejects base64 that decodes to the wrong size", () => {
      expect(() =>
        assertValidEncryptionKey(
          Buffer.alloc(20).toString("base64"),
          "the key",
        ),
      ).toThrow(/the key decodes to 20 bytes/);
    });

    it("rejects a non-string", () => {
      expect(() => assertValidEncryptionKey(123, "the key")).toThrow(
        /the key must be a string.*received number/,
      );
    });

    it("validates the environment variable too", () => {
      process.env.RANGO_ENCRYPTION_KEY = "short";
      expect(() => configureEncryptionKey(undefined)).toThrow(
        /RANGO_ENCRYPTION_KEY/,
      );
    });
  });

  describe("rango({ encryptionKey })", () => {
    it("throws at config time for an invalid key", async () => {
      await expect(
        rango({ banner: false, encryptionKey: "my secret" }),
      ).rejects.toThrow(/rango\(\{ encryptionKey \}\) is not valid base64/);
    });

    it("throws for an empty key instead of generating one", async () => {
      await expect(rango({ banner: false, encryptionKey: "" })).rejects.toThrow(
        /is an empty string/,
      );
    });

    it("hands the key to plugin-rsc for the build and the discovery server", async () => {
      await rango({ banner: false, encryptionKey: KEY_32 });
      expect(defineEncryptionKeyExpr()).toBe(JSON.stringify(KEY_32));
      expect(isEncryptionKeyStable()).toBe(true);
    });

    it("treats an unset variable passed through the option as no key", async () => {
      // rango({ encryptionKey: process.env.RANGO_ENCRYPTION_KEY }) with the
      // variable unset: generate, do not throw.
      await rango({ banner: false, encryptionKey: undefined });
      expect(isEncryptionKeyStable()).toBe(false);
    });
  });
});
