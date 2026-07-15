import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { GrokInstallation } from "../shared/contracts.js";

const VERSION_TIMEOUT_MS = 5_000;
const VERSION_OUTPUT_LIMIT = 8_192;

export async function discoverGrok(
  preferredPath?: string | null,
): Promise<GrokInstallation> {
  const candidates = buildCandidatePaths(preferredPath);
  let preferredError: string | null = null;

  for (const candidate of candidates) {
    const installation = await inspectGrokExecutable(candidate);
    if (installation.found) {
      return installation;
    }
    if (preferredPath && pathsEqual(candidate, preferredPath)) {
      preferredError = installation.error;
    }
  }

  return {
    found: false,
    executablePath: null,
    version: null,
    error: preferredError ?? "未找到本机 Grok 可执行文件，请手动选择 grok.exe。",
  };
}

export async function inspectGrokExecutable(
  executablePath: string,
): Promise<GrokInstallation> {
  const requestedPath = normalizeCandidate(executablePath);
  if (!requestedPath || !hasExpectedExecutableName(requestedPath)) {
    return notFound("所选文件不是受支持的 Grok 可执行文件。");
  }

  try {
    const canonicalPath = await realpath(requestedPath);
    const file = await stat(canonicalPath);
    if (!file.isFile()) {
      return notFound("所选 Grok 路径不是文件。");
    }

    await access(canonicalPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    const version = await readGrokVersion(canonicalPath);

    return {
      found: true,
      executablePath: canonicalPath,
      version,
      error: null,
    };
  } catch (error: unknown) {
    const message = isNodeError(error) && error.code === "EACCES"
      ? "没有权限运行所选 Grok 可执行文件。"
      : "所选 Grok 可执行文件不存在或不可访问。";
    return notFound(message);
  }
}

export function pathsEqual(left: string, right: string): boolean {
  const leftPath = path.resolve(left);
  const rightPath = path.resolve(right);
  return process.platform === "win32"
    ? leftPath.toLocaleLowerCase("en-US") === rightPath.toLocaleLowerCase("en-US")
    : leftPath === rightPath;
}

function buildCandidatePaths(preferredPath?: string | null): string[] {
  const executableName = process.platform === "win32" ? "grok.exe" : "grok";
  const candidates = [
    preferredPath,
    process.env.GROK_EXECUTABLE_PATH,
    path.join(os.homedir(), ".grok", "bin", executableName),
  ];

  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const normalizedDirectory = stripWrappingQuotes(directory.trim());
    if (normalizedDirectory) {
      candidates.push(path.join(normalizedDirectory, executableName));
    }
  }

  const seen = new Set<string>();
  return candidates.flatMap((candidate) => {
    const normalized = normalizeCandidate(candidate);
    if (!normalized) {
      return [];
    }

    const key = process.platform === "win32"
      ? normalized.toLocaleLowerCase("en-US")
      : normalized;
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [normalized];
  });
}

function normalizeCandidate(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const candidate = stripWrappingQuotes(value.trim());
  if (!candidate || candidate.includes("\0")) {
    return null;
  }
  return path.resolve(candidate);
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

function hasExpectedExecutableName(executablePath: string): boolean {
  const name = path.basename(executablePath);
  return process.platform === "win32"
    ? name.toLocaleLowerCase("en-US") === "grok.exe"
    : name === "grok";
}

async function readGrokVersion(executablePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timeout: NodeJS.Timeout | null = null;

    const child = spawn(executablePath, ["--version"], {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (value: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(value);
    };

    const append = (chunk: Buffer): void => {
      if (output.length < VERSION_OUTPUT_LIMIT) {
        output += chunk.toString("utf8", 0, VERSION_OUTPUT_LIMIT - output.length);
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", () => finish(null));
    child.once("close", (exitCode) =>
      finish(exitCode === 0 ? parseVersionOutput(output) : null),
    );

    timeout = setTimeout(() => {
      child.kill();
      finish(null);
    }, VERSION_TIMEOUT_MS);
    timeout.unref();
  });
}

function parseVersionOutput(output: string): string | null {
  const firstLine = output
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return null;
  }
  return firstLine.slice(0, 200);
}

function notFound(error: string): GrokInstallation {
  return {
    found: false,
    executablePath: null,
    version: null,
    error,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
