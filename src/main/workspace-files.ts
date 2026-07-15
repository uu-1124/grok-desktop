import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  MAX_PROMPT_CONTEXT_FILES,
  type ContextFileReference,
} from "../shared/contracts.js";

const MAX_PATH_LENGTH = 32_767;
const MAX_EMBEDDED_CONTEXT_FILE_BYTES = 256 * 1_024;
const MAX_EMBEDDED_CONTEXT_TOTAL_BYTES = 512 * 1_024;

export interface PreparedPromptContextFile extends ContextFileReference {
  text?: string;
  mimeType?: string;
}

export function isPathWithinWorkspace(
  workspacePath: string,
  candidatePath: string,
): boolean {
  const relative = path.relative(workspacePath, candidatePath);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

export async function resolveWorkspaceContextFiles(
  workspacePath: string,
  selectedPaths: readonly string[],
): Promise<ContextFileReference[]> {
  if (selectedPaths.length > MAX_PROMPT_CONTEXT_FILES) {
    throw new Error(`一次最多引用 ${MAX_PROMPT_CONTEXT_FILES} 个文件。`);
  }

  const canonicalWorkspace = await realpath(workspacePath);
  const references: ContextFileReference[] = [];
  const seen = new Set<string>();
  for (const selectedPath of selectedPaths) {
    if (
      typeof selectedPath !== "string" ||
      !path.isAbsolute(selectedPath) ||
      selectedPath.length > MAX_PATH_LENGTH ||
      selectedPath.includes("\0")
    ) {
      throw new Error("所选上下文文件路径无效。");
    }

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(selectedPath);
      const entry = await stat(canonicalPath);
      if (!entry.isFile()) {
        throw new Error("只能引用普通文件。");
      }
      if (!isPathWithinWorkspace(canonicalWorkspace, canonicalPath)) {
        throw new Error("只能引用当前工作区内的文件。");
      }
      const key = process.platform === "win32"
        ? canonicalPath.toLocaleLowerCase("en-US")
        : canonicalPath;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      references.push({
        path: canonicalPath,
        name: path.basename(canonicalPath),
        relativePath: path.relative(canonicalWorkspace, canonicalPath),
        size: Math.min(entry.size, Number.MAX_SAFE_INTEGER),
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        [
          "只能引用普通文件。",
          "只能引用当前工作区内的文件。",
        ].includes(error.message)
      ) {
        throw error;
      }
      throw new Error("上下文文件不存在或不可访问。");
    }
  }
  return references;
}

export async function preparePromptContextFiles(
  references: readonly ContextFileReference[],
  allowEmbeddedContext: boolean,
): Promise<PreparedPromptContextFile[]> {
  if (!allowEmbeddedContext) {
    return references.map((reference) => ({ ...reference }));
  }

  let remainingBytes = MAX_EMBEDDED_CONTEXT_TOTAL_BYTES;
  const prepared: PreparedPromptContextFile[] = [];
  for (const reference of references) {
    if (
      reference.size > MAX_EMBEDDED_CONTEXT_FILE_BYTES ||
      reference.size > remainingBytes
    ) {
      prepared.push({ ...reference });
      continue;
    }

    let content: Uint8Array;
    try {
      content = await readFileBounded(
        reference.path,
        Math.min(MAX_EMBEDDED_CONTEXT_FILE_BYTES, remainingBytes),
      );
    } catch {
      throw new Error(`上下文文件在发送前无法读取：${reference.relativePath}`);
    }
    if (content.byteLength > remainingBytes || isLikelyBinary(content)) {
      prepared.push({ ...reference });
      continue;
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      prepared.push({
        ...reference,
        text,
        mimeType: mimeTypeForPath(reference.path),
      });
      remainingBytes -= content.byteLength;
    } catch {
      prepared.push({ ...reference });
    }
  }
  return prepared;
}

async function readFileBounded(filePath: string, maximumBytes: number): Promise<Uint8Array> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function isLikelyBinary(value: Uint8Array): boolean {
  return value.byteLength > MAX_EMBEDDED_CONTEXT_FILE_BYTES || value.includes(0);
}

function mimeTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLocaleLowerCase("en-US")) {
    case ".json": return "application/json";
    case ".md":
    case ".mdx": return "text/markdown";
    case ".js":
    case ".mjs":
    case ".cjs": return "text/javascript";
    case ".ts":
    case ".tsx": return "text/typescript";
    case ".css": return "text/css";
    case ".html":
    case ".htm": return "text/html";
    case ".xml": return "application/xml";
    case ".yaml":
    case ".yml": return "application/yaml";
    default: return "text/plain";
  }
}
