import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isPathWithinWorkspace,
  preparePromptContextFiles,
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
    })]);
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
    }];

    await expect(preparePromptContextFiles(references, false)).resolves.toEqual(references);
  });
});
