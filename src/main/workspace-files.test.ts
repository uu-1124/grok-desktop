import { mkdtemp, mkdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_PROMPT_IMAGE_FILE_BYTES,
  MAX_PROMPT_IMAGE_TOTAL_BYTES,
  isPathWithinWorkspace,
  preparePromptContextFiles,
  preparePromptImages,
  resolveWorkspaceContextFiles,
} from "./workspace-files";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((temporaryPath) =>
    rm(temporaryPath, { recursive: true, force: true })
  ));
});

describe("workspace context files", () => {
  it("canonicalizes, deduplicates, and describes files inside the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    const sourceDirectory = path.join(workspace, "src");
    const sourceFile = path.join(sourceDirectory, "main.ts");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourceFile, "export {};", "utf8");

    const references = await resolveWorkspaceContextFiles(
      workspace,
      [sourceFile, sourceFile],
    );

    expect(references).toEqual([expect.objectContaining({
      name: "main.ts",
      relativePath: path.join("src", "main.ts"),
      size: 10,
      kind: "file",
      mimeType: null,
    })]);
  });

  it("classifies supported image extensions without reading image data into renderer state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    const imagePath = path.join(workspace, "diagram.PNG");
    await mkdir(workspace, { recursive: true });
    await writeFile(imagePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await expect(resolveWorkspaceContextFiles(workspace, [imagePath])).resolves.toEqual([
      expect.objectContaining({
        name: "diagram.PNG",
        kind: "image",
        mimeType: "image/png",
      }),
    ]);
  });

  it("rejects sibling paths that merely share the workspace prefix", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    const sibling = path.join(root, "workspace-copy");
    const outsideFile = path.join(sibling, "outside.ts");
    await mkdir(workspace, { recursive: true });
    await mkdir(sibling, { recursive: true });
    await writeFile(outsideFile, "outside", "utf8");

    expect(isPathWithinWorkspace(workspace, outsideFile)).toBe(false);
    await expect(resolveWorkspaceContextFiles(workspace, [outsideFile])).rejects.toThrow(
      "当前工作区内",
    );
  });

  it("rejects directories instead of treating them as prompt resources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    const directory = path.join(workspace, "src");
    await mkdir(directory, { recursive: true });

    await expect(resolveWorkspaceContextFiles(workspace, [directory])).rejects.toThrow(
      "普通文件",
    );
  });

  it("embeds bounded UTF-8 text but leaves binary files as resource links", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const textPath = path.join(workspace, "package.json");
    const binaryPath = path.join(workspace, "binary.dat");
    await writeFile(textPath, '{"name":"demo"}', "utf8");
    await writeFile(binaryPath, new Uint8Array([1, 0, 2, 3]));
    const references = await resolveWorkspaceContextFiles(
      workspace,
      [textPath, binaryPath],
    );

    const prepared = await preparePromptContextFiles(references, true);

    expect(prepared[0]).toMatchObject({
      text: '{"name":"demo"}',
      mimeType: "application/json",
    });
    expect(prepared[1]).not.toHaveProperty("text");
  });

  it("does not read file contents when embedded context is unavailable", async () => {
    const references = [{
      path: "D:\\missing.txt",
      name: "missing.txt",
      relativePath: "missing.txt",
      size: 10,
      kind: "file" as const,
      mimeType: null,
    }];

    await expect(preparePromptContextFiles(references, false)).resolves.toEqual(references);
  });

  it("validates image signatures and prepares base64 prompt data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    const imagePath = path.join(workspace, "diagram.png");
    const content = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await mkdir(workspace, { recursive: true });
    await writeFile(imagePath, content);
    const references = await resolveWorkspaceContextFiles(workspace, [imagePath]);

    await expect(preparePromptImages(references)).resolves.toEqual([
      expect.objectContaining({
        kind: "image",
        mimeType: "image/png",
        data: Buffer.from(content).toString("base64"),
      }),
    ]);
  });

  it("rejects image files whose contents do not match their extension", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    const imagePath = path.join(workspace, "forged.png");
    await mkdir(workspace, { recursive: true });
    await writeFile(imagePath, new Uint8Array([0xff, 0xd8, 0xff, 0x00]));
    const references = await resolveWorkspaceContextFiles(workspace, [imagePath]);

    await expect(preparePromptImages(references)).rejects.toThrow();
  });

  it("rejects an individual image above the configured size limit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    const imagePath = path.join(workspace, "oversized.png");
    await mkdir(workspace, { recursive: true });
    await writeFile(imagePath, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await truncate(imagePath, MAX_PROMPT_IMAGE_FILE_BYTES + 1);

    await expect(resolveWorkspaceContextFiles(workspace, [imagePath])).rejects.toThrow();
  });

  it("rechecks the actual combined image size immediately before sending", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-context-"));
    temporaryPaths.push(root);
    const workspace = path.join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    const imagePaths = ["one.png", "two.png", "three.png"].map((name) =>
      path.join(workspace, name)
    );
    const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const imagePath of imagePaths) await writeFile(imagePath, signature);
    const references = await resolveWorkspaceContextFiles(workspace, imagePaths);
    const grownSize = Math.floor(MAX_PROMPT_IMAGE_TOTAL_BYTES / imagePaths.length) + 1;
    for (const imagePath of imagePaths) await truncate(imagePath, grownSize);

    await expect(preparePromptImages(references)).rejects.toThrow();
  });
});
