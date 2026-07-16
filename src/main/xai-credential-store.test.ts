import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { XaiCredentialStore } from "./xai-credential-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("XaiCredentialStore", () => {
  it("persists only encrypted user-bound data and restores it for the same origin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-credential-"));
    temporaryDirectories.push(root);
    const safeStorage = createFakeSafeStorage();
    const store = new XaiCredentialStore(root, safeStorage, "win32");

    await store.save("https://gateway.example.com/v1", "test-user-key");

    const serialized = await readFile(path.join(root, "xai-credential.bin"));
    expect(serialized.toString("utf8")).not.toContain("test-user-key");
    expect(serialized.toString("utf8")).not.toContain("gateway.example.com");
    const restored = new XaiCredentialStore(root, safeStorage, "win32");
    await expect(restored.getStatus()).resolves.toEqual({
      available: true,
      scope: "https://gateway.example.com",
      secureStorageAvailable: true,
    });
    await expect(restored.loadForBaseUrl("https://gateway.example.com/v2"))
      .resolves.toBe("test-user-key");
    await expect(restored.loadForBaseUrl("https://other.example.com/v1"))
      .resolves.toBeNull();
  });

  it("clears the encrypted credential without affecting ordinary settings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-credential-"));
    temporaryDirectories.push(root);
    const store = new XaiCredentialStore(root, createFakeSafeStorage(), "win32");
    await writeFile(path.join(root, "settings.json"), "keep-settings", "utf8");
    await store.save("https://gateway.example.com/v1", "test-user-key");

    await store.clear();

    await expect(store.getStatus()).resolves.toEqual({
      available: false,
      scope: null,
      secureStorageAvailable: true,
    });
    await expect(readFile(path.join(root, "settings.json"), "utf8"))
      .resolves.toBe("keep-settings");
  });

  it("atomically replaces the previous origin credential with the newly connected one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-credential-"));
    temporaryDirectories.push(root);
    const store = new XaiCredentialStore(root, createFakeSafeStorage(), "win32");
    await store.save("https://first.example.com/v1", "first-key");

    await store.save("https://second.example.com/v1", "second-key");

    await expect(store.loadForBaseUrl("https://first.example.com/v1")).resolves.toBeNull();
    await expect(store.loadForBaseUrl("https://second.example.com/v1"))
      .resolves.toBe("second-key");
  });

  it("never falls back to Linux basic-text encryption", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-credential-"));
    temporaryDirectories.push(root);
    const store = new XaiCredentialStore(root, {
      ...createFakeSafeStorage(),
      getSelectedStorageBackend: () => "basic_text",
    }, "linux");

    await expect(store.save("https://gateway.example.com/v1", "test-user-key"))
      .rejects.toThrow("不会写入磁盘");
    await expect(store.getStatus()).resolves.toEqual({
      available: false,
      scope: null,
      secureStorageAvailable: false,
    });
  });

  it("fails closed when encrypted data is corrupted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-credential-"));
    temporaryDirectories.push(root);
    await writeFile(path.join(root, "xai-credential.bin"), "not-encrypted", "utf8");
    const store = new XaiCredentialStore(root, createFakeSafeStorage(), "win32");

    await expect(store.getStatus()).resolves.toEqual({
      available: false,
      scope: null,
      secureStorageAvailable: true,
    });
    await expect(store.loadForBaseUrl("https://gateway.example.com/v1"))
      .rejects.toThrow("无法解密");
  });
});

function createFakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText: string) =>
      Buffer.from(`protected:${Buffer.from(plainText, "utf8").toString("base64")}`, "utf8"),
    decryptString: (encrypted: Buffer) => {
      const serialized = encrypted.toString("utf8");
      if (!serialized.startsWith("protected:")) throw new Error("invalid ciphertext");
      return Buffer.from(serialized.slice("protected:".length), "base64").toString("utf8");
    },
  };
}
