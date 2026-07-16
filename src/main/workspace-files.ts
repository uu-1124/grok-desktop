import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  MAX_PROMPT_CONTEXT_FILES,
  type ContextFileReference,
} from "../shared/contracts.js";

const MAX_PATH_LENGTH = 32_767;
const MAX_EMBEDDED_CONTEXT_FILE_BYTES = 256 * 1_024;
const MAX_EMBEDDED_CONTEXT_TOTAL_BYTES = 512 * 1_024;
export const MAX_PROMPT_IMAGE_FILE_BYTES = 10 * 1_024 * 1_024;
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 20 * 1_024 * 1_024;

const IMAGE_MIME_TYPES = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);

export interface PreparedPromptContextFile extends ContextFileReference {
  text?: string;
}

export interface PreparedPromptImage extends ContextFileReference {
  kind: "image";
  mimeType: string;
  data: string;
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
  options: { allowExternalImages?: boolean } = {},
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
      const imageMimeType = imageMimeTypeForPath(canonicalPath);
      if (!isPathWithinWorkspace(canonicalWorkspace, canonicalPath) &&
        !(options.allowExternalImages && imageMimeType)) {
        throw new Error("只能引用当前工作区内的文件。");
      }
      const key = process.platform === "win32"
        ? canonicalPath.toLocaleLowerCase("en-US")
        : canonicalPath;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      if (imageMimeType && entry.size > MAX_PROMPT_IMAGE_FILE_BYTES) {
        throw new Error(
          `图片不能超过 ${MAX_PROMPT_IMAGE_FILE_BYTES / 1_024 / 1_024} MiB。`,
        );
      }
      references.push({
        path: canonicalPath,
        name: path.basename(canonicalPath),
        relativePath: path.relative(canonicalWorkspace, canonicalPath),
        size: Math.min(entry.size, Number.MAX_SAFE_INTEGER),
        kind: imageMimeType ? "image" : "file",
        mimeType: imageMimeType,
      });
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        [
          "只能引用普通文件。",
          "只能引用当前工作区内的文件。",
          `图片不能超过 ${MAX_PROMPT_IMAGE_FILE_BYTES / 1_024 / 1_024} MiB。`,
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
        mimeType: textMimeTypeForPath(reference.path),
      });
      remainingBytes -= content.byteLength;
    } catch {
      prepared.push({ ...reference });
    }
  }
  return prepared;
}

export async function preparePromptImages(
  references: readonly ContextFileReference[],
): Promise<PreparedPromptImage[]> {
  let remainingBytes = MAX_PROMPT_IMAGE_TOTAL_BYTES;
  const prepared: PreparedPromptImage[] = [];
  for (const reference of references) {
    const expectedMimeType = imageMimeTypeForPath(reference.path);
    if (
      reference.kind !== "image" ||
      !expectedMimeType ||
      reference.mimeType !== expectedMimeType
    ) {
      throw new Error(`不支持的图片格式：${reference.relativePath}`);
    }
    if (reference.size > MAX_PROMPT_IMAGE_FILE_BYTES || reference.size > remainingBytes) {
      throw new Error(
        `图片附件总大小不能超过 ${MAX_PROMPT_IMAGE_TOTAL_BYTES / 1_024 / 1_024} MiB。`,
      );
    }

    let content: Uint8Array;
    try {
      content = await readFileBounded(reference.path, MAX_PROMPT_IMAGE_FILE_BYTES);
    } catch {
      throw new Error(`图片在发送前无法读取：${reference.relativePath}`);
    }
    if (content.byteLength > MAX_PROMPT_IMAGE_FILE_BYTES) {
      throw new Error(
        `图片不能超过 ${MAX_PROMPT_IMAGE_FILE_BYTES / 1_024 / 1_024} MiB：${reference.relativePath}`,
      );
    }
    if (content.byteLength > remainingBytes) {
      throw new Error(
        `图片附件总大小不能超过 ${MAX_PROMPT_IMAGE_TOTAL_BYTES / 1_024 / 1_024} MiB。`,
      );
    }
    if (detectImageMimeType(content) !== expectedMimeType) {
      throw new Error(`图片内容与文件格式不匹配：${reference.relativePath}`);
    }

    prepared.push({
      ...reference,
      kind: "image",
      mimeType: expectedMimeType,
      data: Buffer.from(content).toString("base64"),
    });
    remainingBytes -= content.byteLength;
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

function imageMimeTypeForPath(filePath: string): string | null {
  return IMAGE_MIME_TYPES.get(path.extname(filePath).toLocaleLowerCase("en-US")) ?? null;
}

function detectImageMimeType(value: Uint8Array): string | null {
  if (
    value.length >= 8 &&
    value[0] === 0x89 && value[1] === 0x50 && value[2] === 0x4e && value[3] === 0x47 &&
    value[4] === 0x0d && value[5] === 0x0a && value[6] === 0x1a && value[7] === 0x0a
  ) {
    return "image/png";
  }
  if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) {
    return "image/jpeg";
  }
  if (value.length >= 6) {
    const signature = Buffer.from(value.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    value.length >= 12 &&
    Buffer.from(value.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(value.subarray(8, 12)).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function textMimeTypeForPath(filePath: string): string {
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
