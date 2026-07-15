import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

const MAX_URL_LENGTH = 2_048;

export async function openHttpsInChrome(rawUrl: string): Promise<void> {
  const url = validateExternalUrl(rawUrl);
  const chromePath = await findInstalledChrome();
  if (!chromePath) {
    throw new Error("未找到本机 Google Chrome，无法打开外部链接。");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(chromePath, [url.toString()], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });

    child.once("error", () => reject(new Error("启动 Google Chrome 失败。")));
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function findInstalledChrome(): Promise<string | null> {
  for (const candidate of chromeCandidates()) {
    try {
      const file = await stat(candidate);
      if (file.isFile() && hasChromeExecutableName(candidate)) {
        return candidate;
      }
    } catch {
      // Continue through known local installation locations.
    }
  }
  return null;
}

function validateExternalUrl(rawUrl: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > MAX_URL_LENGTH) {
    throw new Error("外部链接无效。");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("外部链接无效。");
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("只允许通过 Google Chrome 打开 HTTPS 链接。");
  }
  return url;
}

function chromeCandidates(): string[] {
  if (process.platform === "win32") {
    const roots = [
      process.env.LOCALAPPDATA,
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
    ];
    return uniquePaths(
      roots.flatMap((root) =>
        root ? [path.join(root, "Google", "Chrome", "Application", "chrome.exe")] : [],
      ),
    );
  }

  if (process.platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  }

  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    const key = process.platform === "win32"
      ? candidate.toLocaleLowerCase("en-US")
      : candidate;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasChromeExecutableName(executablePath: string): boolean {
  const name = path.basename(executablePath);
  if (process.platform === "win32") {
    return name.toLocaleLowerCase("en-US") === "chrome.exe";
  }
  return name === "Google Chrome" || name.startsWith("google-chrome");
}
