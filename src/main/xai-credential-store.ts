import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { XaiCredentialStatus } from "../shared/contracts.js";
import {
  getXaiApiCredentialScope,
  normalizeXaiApiKey,
} from "../shared/xai-connection.js";

const CREDENTIAL_SCHEMA_VERSION = 1;
const MAX_ENCRYPTED_CREDENTIAL_BYTES = 128 * 1_024;

interface SafeStorageProvider {
  decryptString(encrypted: Buffer): string;
  encryptString(plainText: string): Buffer;
  getSelectedStorageBackend?(): string;
  isEncryptionAvailable(): boolean;
}

interface StoredXaiCredential {
  schemaVersion: typeof CREDENTIAL_SCHEMA_VERSION;
  scope: string;
  xaiApiKey: string;
}

export class XaiCredentialStore {
  readonly #credentialPath: string;
  readonly #platform: NodeJS.Platform;
  readonly #safeStorage: SafeStorageProvider;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(
    userDataPath: string,
    safeStorage: SafeStorageProvider,
    platform: NodeJS.Platform = process.platform,
  ) {
    this.#credentialPath = path.join(userDataPath, "xai-credential.bin");
    this.#safeStorage = safeStorage;
    this.#platform = platform;
  }

  async getStatus(): Promise<XaiCredentialStatus> {
    const secureStorageAvailable = this.#isSecureStorageAvailable();
    if (!secureStorageAvailable) {
      return { available: false, scope: null, secureStorageAvailable: false };
    }
    try {
      const credential = await this.#readCredential();
      return {
        available: credential !== null,
        scope: credential?.scope ?? null,
        secureStorageAvailable: true,
      };
    } catch {
      return { available: false, scope: null, secureStorageAvailable: true };
    }
  }

  async loadForBaseUrl(baseUrl: string): Promise<string | null> {
    if (!this.#isSecureStorageAvailable()) {
      throw new Error("当前系统安全凭据存储不可用，请重新输入 API Key。");
    }
    let credential: StoredXaiCredential | null;
    try {
      credential = await this.#readCredential();
    } catch {
      throw new Error("本机保存的 API Key 无法解密，请重新输入。");
    }
    if (!credential) return null;
    const scope = getXaiApiCredentialScope(baseUrl);
    return typeof scope === "string" && scope === credential.scope
      ? credential.xaiApiKey
      : null;
  }

  async save(baseUrl: string, apiKey: string): Promise<void> {
    if (!this.#isSecureStorageAvailable()) {
      throw new Error("当前系统不提供安全凭据存储，API Key 不会写入磁盘。");
    }
    const scope = getXaiApiCredentialScope(baseUrl);
    const normalizedApiKey = normalizeXaiApiKey(apiKey);
    if (typeof scope !== "string" || typeof normalizedApiKey !== "string") {
      throw new TypeError("API Key 凭据范围无效。");
    }
    const encrypted = this.#safeStorage.encryptString(JSON.stringify({
      schemaVersion: CREDENTIAL_SCHEMA_VERSION,
      scope,
      xaiApiKey: normalizedApiKey,
    } satisfies StoredXaiCredential));
    if (encrypted.byteLength === 0 || encrypted.byteLength > MAX_ENCRYPTED_CREDENTIAL_BYTES) {
      throw new Error("加密后的 API Key 数据大小无效。");
    }

    await this.#enqueueWrite(async () => {
      const directory = path.dirname(this.#credentialPath);
      const temporaryPath = `${this.#credentialPath}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(temporaryPath, encrypted, { mode: 0o600, flag: "wx" });
        await rename(temporaryPath, this.#credentialPath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async clear(): Promise<void> {
    await this.#enqueueWrite(() => rm(this.#credentialPath, { force: true }));
  }

  async #readCredential(): Promise<StoredXaiCredential | null> {
    let fileInfo;
    try {
      fileInfo = await lstat(this.#credentialPath);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
      throw new Error("Invalid encrypted credential file.");
    }
    if (fileInfo.size <= 0 || fileInfo.size > MAX_ENCRYPTED_CREDENTIAL_BYTES) {
      throw new Error("Invalid encrypted credential size.");
    }
    const encrypted = await readFile(this.#credentialPath);
    const parsed: unknown = JSON.parse(this.#safeStorage.decryptString(encrypted));
    if (!isRecord(parsed) || parsed.schemaVersion !== CREDENTIAL_SCHEMA_VERSION) {
      throw new Error("Unsupported encrypted credential document.");
    }
    const scope = getXaiApiCredentialScope(parsed.scope);
    const xaiApiKey = normalizeXaiApiKey(parsed.xaiApiKey);
    if (typeof scope !== "string" || scope !== parsed.scope || typeof xaiApiKey !== "string") {
      throw new Error("Invalid encrypted credential document.");
    }
    return { schemaVersion: CREDENTIAL_SCHEMA_VERSION, scope, xaiApiKey };
  }

  #isSecureStorageAvailable(): boolean {
    try {
      if (!this.#safeStorage.isEncryptionAvailable()) return false;
      if (this.#platform !== "linux") return true;
      const backend = this.#safeStorage.getSelectedStorageBackend?.();
      return backend !== undefined && backend !== "basic_text" && backend !== "unknown";
    } catch {
      return false;
    }
  }

  async #enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const write = this.#writeQueue.then(operation);
    this.#writeQueue = write.catch(() => undefined);
    await write;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
