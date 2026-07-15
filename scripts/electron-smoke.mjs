import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(SCRIPT_DIR, "..");
const ARTIFACTS_DIR = path.join(WORKSPACE_ROOT, "artifacts");
const APP_PATH = path.resolve(
  process.env.GROK_E2E_APP ||
    path.join(WORKSPACE_ROOT, "release", "win-unpacked", "Grok Desktop.exe"),
);
const GROK_PATH = path.resolve(
  process.env.GROK_E2E_EXECUTABLE ||
    path.join(os.homedir(), ".grok", "bin", "grok.exe"),
);
const TEST_WORKSPACE = path.resolve(process.env.GROK_E2E_WORKSPACE || WORKSPACE_ROOT);
const KEEP_USER_DATA = process.env.GROK_E2E_KEEP_USER_DATA === "1";
const MISSING_SESSION_ID = "electron-smoke-missing-session";
const MISSING_SESSION_TITLE = "Electron smoke · 不存在的历史任务";
const CUSTOM_BASE_URL = "http://127.0.0.1:65534/v1";
const HISTORY_SCREENSHOT = path.join(ARTIFACTS_DIR, "electron-smoke-history-recovery.png");
const AUTH_SCREENSHOT = path.join(ARTIFACTS_DIR, "electron-smoke-native-auth.png");
const PERMISSION_SCREENSHOT = path.join(ARTIFACTS_DIR, "electron-smoke-permission-light.png");
const PERMISSION_NARROW_SCREENSHOT = path.join(ARTIFACTS_DIR, "electron-smoke-permission-1280x720.png");
const PERMISSION_FIXTURE_HTML = `
  <div class="modal-layer modal-layer--permission" data-electron-smoke-permission role="presentation">
    <section class="modal permission-modal" role="alertdialog" aria-modal="true">
      <header><div class="permission-icon" aria-hidden="true">!</div><div><p class="eyebrow">需要你的授权</p><h2>Grok 请求执行本地操作</h2></div></header>
      <div class="permission-source-warning"><span>这项请求会修改工作区，请核对来源和影响范围。</span></div>
      <div class="permission-source"><span aria-hidden="true">G</span><div><small>请求来源</small><strong>权限弹窗视觉验收</strong><code>D:\\AI员工\\项目\\grok桌面端</code></div><em>smoke-ui</em></div>
      <div class="permission-tool"><span aria-hidden="true">›_</span><div><strong>运行聚焦测试</strong><small>执行命令 · 1 个位置</small></div></div>
      <div class="permission-impact"><div><span>命令</span><code>npm test</code></div><div><span>工作目录</span><code>D:\\AI员工\\项目\\grok桌面端</code></div></div>
      <div class="permission-expiry">将在 60 秒后自动取消</div>
      <details class="permission-details"><summary>更多详情（敏感字段已隐藏）</summary><pre>{ "command": "npm test" }</pre></details>
      <div class="permission-options"><button class="primary-button permission-option permission-option--allow_once" type="button"><span><strong>允许</strong><small>仅批准这一次</small></span></button><button class="subtle-button permission-option permission-option--reject_once" type="button"><span><strong>拒绝</strong><small>仅拒绝这一次</small></span></button><section class="permission-persistent"><div><span>持续决定会影响后续同类请求。</span></div><button class="danger-button permission-option permission-option--allow_always" type="button"><span><strong>始终允许</strong><small>对后续同类操作持续批准</small></span></button><button class="subtle-button permission-option permission-option--reject_always" type="button"><span><strong>始终拒绝</strong><small>对后续同类操作持续拒绝</small></span></button></section></div>
      <button class="permission-cancel" type="button">取消此次操作</button>
    </section>
  </div>`;

async function main() {
if (process.platform !== "win32") {
  throw new Error("Electron smoke currently requires Windows.");
}

await requireRegularFile(APP_PATH, "Packaged Grok Desktop executable");
await requireRegularFile(GROK_PATH, "Installed Grok executable");
await requireDirectory(TEST_WORKSPACE, "Smoke workspace");
await mkdir(ARTIFACTS_DIR, { recursive: true });

const userDataPath = await mkdtemp(path.join(os.tmpdir(), "grok-desktop-smoke-"));
assertSafeTemporaryUserDataPath(userDataPath);
await writeSmokeSettings(userDataPath);

const childEnvironment = { ...process.env };
delete childEnvironment.XAI_API_KEY;
delete childEnvironment.GROK_CODE_XAI_API_KEY;

const appProcess = spawn(APP_PATH, [
  "--remote-debugging-port=0",
  `--user-data-dir=${userDataPath}`,
  "--force-device-scale-factor=1.5",
], {
  cwd: WORKSPACE_ROOT,
  env: childEnvironment,
  shell: false,
  stdio: "ignore",
  windowsHide: true,
});

let cdp = null;
let passed = false;
try {
  await waitForChildSpawn(appProcess);
  const debuggingPort = await waitForDevToolsPort(userDataPath, appProcess);
  cdp = await CdpClient.connect(debuggingPort, appProcess);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const historyRecovery = await cdp.evaluate(`(async () => {
    const waitFor = async (predicate, timeout = 35000) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error("Timed out waiting for history recovery UI");
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    };
    await waitFor(() => document.querySelector(".app"));
    await waitFor(() => [...document.querySelectorAll(".session-row")].some((item) =>
      item.textContent.includes(${JSON.stringify(MISSING_SESSION_TITLE)}) && !item.disabled
    ));
    const row = [...document.querySelectorAll(".session-row")].find((item) =>
      item.textContent.includes(${JSON.stringify(MISSING_SESSION_TITLE)})
    );
    if (!row) throw new Error("Smoke history row was not rendered");
    row.click();
    await waitFor(() => document.querySelector(".session-load-recovery"));
    const firstDetail = document.querySelector(".session-load-recovery small")?.textContent ?? "";
    const firstToastCount = document.querySelectorAll(".toast").length;
    await waitFor(() => !document.querySelector(".session-load-recovery__actions button")?.disabled);
    document.querySelector(".session-load-recovery__actions button")?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await waitFor(() => document.querySelector(".session-load-recovery") &&
      !document.querySelector(".session-load-recovery__actions button")?.disabled);
    const retryToastCount = document.querySelectorAll(".toast").length;
    const removeButton = [...document.querySelectorAll(".session-load-recovery__actions button")].find(
      (button) => button.textContent.includes("从列表移除"),
    );
    removeButton?.click();
    await waitFor(() => document.querySelector(".session-remove-confirmation"));
    const defaultFocus = document.activeElement?.textContent ?? "";
    [...document.querySelectorAll(".session-remove-confirmation button")].find(
      (button) => button.textContent.includes("取消"),
    )?.click();
    await waitFor(() => !document.querySelector(".session-remove-confirmation"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      firstDetail,
      firstToastCount,
      retryToastCount,
      defaultFocus,
      restoredFocus: document.activeElement?.textContent ?? "",
      restoredFocusSource: document.activeElement?.dataset?.sessionRemovalTrigger ?? "",
      bodyContainsIpcWrapper: document.body.innerText.includes("Error invoking remote method"),
      devicePixelRatio,
    };
  })()`);

  assert.equal(historyRecovery.firstToastCount, 1, "Initial history failure should show one toast");
  assert.equal(historyRecovery.retryToastCount, 1, "Retry must not duplicate the same toast");
  assert.equal(historyRecovery.defaultFocus, "取消", "Removal confirmation must focus cancel");
  assert.equal(historyRecovery.restoredFocus, "从列表移除", "Cancel must restore the recovery action focus");
  assert.equal(historyRecovery.restoredFocusSource, "recovery");
  assert.equal(historyRecovery.bodyContainsIpcWrapper, false, "Electron IPC plumbing reached the UI");
  assert.match(historyRecovery.firstDetail, /Grok 找不到这条历史任务/u);
  assert.equal(historyRecovery.devicePixelRatio, 1.5);
  await cdp.captureScreenshot(HISTORY_SCREENSHOT);

  const removal = await cdp.evaluate(`(async () => {
    const waitFor = async (predicate, timeout = 20000) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error("Timed out removing smoke history");
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    };
    document.activeElement?.click();
    await waitFor(() => document.querySelector(".session-remove-confirmation"));
    [...document.querySelectorAll(".session-remove-confirmation button")].find(
      (button) => button.textContent.trim() === "移除",
    )?.click();
    await waitFor(() => ![...document.querySelectorAll(".session-row")].some((item) =>
      item.textContent.includes(${JSON.stringify(MISSING_SESSION_TITLE)})
    ));
    return {
      targetVisible: [...document.querySelectorAll(".session-row")].some((item) =>
        item.textContent.includes(${JSON.stringify(MISSING_SESSION_TITLE)})
      ),
      successToast: [...document.querySelectorAll(".toast")].at(-1)?.textContent ?? "",
    };
  })()`);

  assert.equal(removal.targetVisible, false);
  assert.match(removal.successToast, /Grok 原始会话未删除/u);
  const persistedAfterRemoval = JSON.parse(
    await readFile(path.join(userDataPath, "settings.json"), "utf8"),
  );
  assert.equal(
    persistedAfterRemoval.settings.recentSessions.some(
      (session) => session.sessionId === MISSING_SESSION_ID,
    ),
    false,
    "Removed desktop history was not persisted",
  );

  const nativeAuth = await cdp.evaluate(`(async () => {
    const waitFor = async (predicate, timeout = 20000) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error("Timed out waiting for native auth UI");
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    };
    document.querySelector('button[aria-label="打开设置"]')?.click();
    await waitFor(() => document.querySelector(".settings-modal"));
    const baseUrl = document.querySelector("#xai-api-base-url");
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(baseUrl, "");
    baseUrl?.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    [...document.querySelectorAll(".settings-modal > footer button")].find((button) =>
      button.textContent.includes("应用")
    )?.click();
    await waitFor(() => !document.querySelector(".settings-modal"));
    await waitFor(() => document.querySelector(".app")?.dataset.phase === "ready");
    await waitFor(() => !document.querySelector('button[aria-label="打开设置"]')?.disabled);
    document.querySelector('button[aria-label="打开设置"]')?.click();
    await waitFor(() => document.querySelector(".native-auth-summary"));
    const card = document.querySelector(".native-auth-summary");
    return {
      methods: [...card.querySelectorAll("li")].map((item) => item.textContent),
      buttonText: card.querySelector("button")?.textContent ?? "",
      buttonDisabled: card.querySelector("button")?.disabled ?? true,
      savedBaseUrl: document.querySelector("#xai-api-base-url")?.value ?? "missing",
      bodyContainsAuthenticateButton: document.body.innerText.includes("authenticate"),
    };
  })()`);

  assert.equal(nativeAuth.savedBaseUrl, "");
  assert.equal(nativeAuth.buttonText, "打开原始终端");
  assert.equal(nativeAuth.buttonDisabled, false);
  assert.equal(nativeAuth.bodyContainsAuthenticateButton, false);
  assert.equal(nativeAuth.methods.some((method) => method.includes("API Key")), true);
  assert.equal(nativeAuth.methods.some((method) => method.includes("Grok 登录")), true);
  await cdp.captureScreenshot(AUTH_SCREENSHOT);

  const permissionVisual = await cdp.evaluate(`(() => {
    document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(PERMISSION_FIXTURE_HTML)});
    const layer = document.querySelector("[data-electron-smoke-permission]");
    const modal = layer?.querySelector(".permission-modal");
    const source = layer?.querySelector(".permission-source");
    const primary = layer?.querySelector(".permission-option--allow_once");
    const toastStack = document.querySelector(".toast-stack");
    return {
      layerZIndex: layer ? getComputedStyle(layer).zIndex : "missing",
      modalBackground: modal ? getComputedStyle(modal).backgroundColor : "missing",
      modalColorScheme: modal ? getComputedStyle(modal).colorScheme : "missing",
      sourceBackground: source ? getComputedStyle(source).backgroundColor : "missing",
      primaryBackground: primary ? getComputedStyle(primary).backgroundColor : "missing",
      toastZIndex: toastStack ? getComputedStyle(toastStack).zIndex : "missing",
    };
  })()`);

  assert.equal(permissionVisual.layerZIndex, "160");
  assert.equal(permissionVisual.modalBackground, "rgb(251, 251, 249)");
  assert.equal(permissionVisual.modalColorScheme, "light");
  assert.equal(permissionVisual.sourceBackground, "rgb(244, 244, 241)");
  assert.equal(permissionVisual.primaryBackground, "rgb(37, 37, 33)");
  assert.equal(permissionVisual.toastZIndex, "150");
  await cdp.captureScreenshot(PERMISSION_SCREENSHOT);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(100);
  const permissionNarrow = await cdp.evaluate(`(async () => {
    const modal = document.querySelector("[data-electron-smoke-permission] .permission-modal");
    const fullyVisible = (element) => {
      if (!modal || !element) return false;
      const modalRect = modal.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return rect.top >= modalRect.top && rect.bottom <= modalRect.bottom && rect.top >= 0 && rect.bottom <= innerHeight;
    };
    const primary = modal?.querySelector(".permission-option--allow_once");
    const reject = modal?.querySelector(".permission-option--reject_once");
    const persistent = modal?.querySelector(".permission-persistent");
    const persistentReject = modal?.querySelector(".permission-option--reject_always");
    const cancel = modal?.querySelector(".permission-cancel");
    const initial = {
      viewport: { width: innerWidth, height: innerHeight },
      modalClientHeight: modal?.clientHeight ?? 0,
      modalScrollHeight: modal?.scrollHeight ?? 0,
      primaryVisible: fullyVisible(primary),
      rejectVisible: fullyVisible(reject),
      persistentVisible: fullyVisible(persistent),
      cancelVisible: fullyVisible(cancel),
      cancelPosition: cancel ? getComputedStyle(cancel).position : "missing",
    };
    if (modal) modal.scrollTop = modal.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const cancelRect = cancel?.getBoundingClientRect();
    const persistentRejectRect = persistentReject?.getBoundingClientRect();
    const bottom = {
      cancelVisibleAtBottom: fullyVisible(cancel),
      persistentRejectVisibleAtBottom: Boolean(
        cancelRect && persistentRejectRect &&
        persistentRejectRect.top >= modal.getBoundingClientRect().top &&
        persistentRejectRect.bottom <= cancelRect.top
      ),
    };
    if (modal) modal.scrollTop = 0;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return { ...initial, ...bottom };
  })()`);
  assert.deepEqual(permissionNarrow.viewport, { width: 1280, height: 720 });
  assert.equal(permissionNarrow.modalClientHeight <= 676, true);
  assert.equal(permissionNarrow.primaryVisible, true);
  assert.equal(permissionNarrow.rejectVisible, true);
  assert.equal(permissionNarrow.cancelVisible, true);
  assert.equal(permissionNarrow.cancelPosition, "sticky");
  assert.equal(permissionNarrow.cancelVisibleAtBottom, true);
  assert.equal(permissionNarrow.persistentRejectVisibleAtBottom, true);
  await cdp.captureScreenshot(PERMISSION_NARROW_SCREENSHOT);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await cdp.evaluate('document.querySelector("[data-electron-smoke-permission]")?.remove()');

  const terminal = await cdp.evaluate(`(async () => {
    const waitFor = async (predicate, timeout = 20000) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error("Timed out opening the raw terminal");
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    };
    document.querySelector(".native-auth-summary button")?.click();
    await waitFor(() => document.querySelector(".terminal-panel"));
    return {
      settingsClosed: !document.querySelector(".settings-modal"),
      terminalVisible: Boolean(document.querySelector(".terminal-panel")),
      runtimeLabel: document.querySelector(".runtime-pill")?.textContent ?? "",
    };
  })()`);

  assert.equal(terminal.settingsClosed, true);
  assert.equal(terminal.terminalVisible, true);
  assert.equal(terminal.runtimeLabel, "原始终端");

  passed = true;
  console.log(JSON.stringify({
    status: "passed",
    appPath: APP_PATH,
    grokPath: GROK_PATH,
    workspacePath: TEST_WORKSPACE,
    historyRecovery,
    nativeAuth,
    permissionVisual,
    permissionNarrow,
    terminal,
    screenshots: [HISTORY_SCREENSHOT, AUTH_SCREENSHOT, PERMISSION_SCREENSHOT, PERMISSION_NARROW_SCREENSHOT],
  }, null, 2));
} finally {
  if (cdp) {
    try {
      await cdp.evaluate("window.close()");
    } catch {
      // The window may already be closing after a failed assertion.
    }
    cdp.close();
  }
  const exited = await waitForProcessExit(appProcess, 5_000);
  if (!exited) {
    await terminateProcessTree(appProcess.pid);
    await waitForProcessExit(appProcess, 5_000);
  }
  if (passed && !KEEP_USER_DATA) {
    assertSafeTemporaryUserDataPath(userDataPath);
    await rm(userDataPath, { recursive: true, force: true });
  } else if (passed) {
    console.log(`Electron smoke userData retained at: ${userDataPath}`);
  } else {
    console.error(`Electron smoke userData retained at: ${userDataPath}`);
  }
}
}

async function writeSmokeSettings(userDataDirectory) {
  const now = new Date();
  const createdAt = new Date(now.getTime() - 60_000).toISOString();
  await writeFile(path.join(userDataDirectory, "settings.json"), `${JSON.stringify({
    schemaVersion: 1,
    settings: {
      grokExecutablePath: GROK_PATH,
      xaiApiBaseUrl: CUSTOM_BASE_URL,
      lastWorkspacePath: TEST_WORKSPACE,
      recentWorkspaces: [{
        path: TEST_WORKSPACE,
        label: path.basename(TEST_WORKSPACE),
        lastOpenedAt: now.toISOString(),
      }],
      recentSessions: [{
        sessionId: MISSING_SESSION_ID,
        workspacePath: TEST_WORKSPACE,
        title: MISSING_SESSION_TITLE,
        createdAt,
        updatedAt: createdAt,
      }],
    },
  }, null, 2)}\n`, "utf8");
}

async function waitForDevToolsPort(userDataDirectory, child) {
  const activePortPath = path.join(userDataDirectory, "DevToolsActivePort");
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (child.exitCode !== null) {
      throw new Error(`Grok Desktop exited before CDP became available (${child.exitCode}).`);
    }
    try {
      const [portLine] = (await readFile(activePortPath, "utf8")).split(/\r?\n/u);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
    } catch {
      // Chromium creates DevToolsActivePort after the browser process is ready.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for Electron DevToolsActivePort.");
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Electron CDP connection closed."));
      }
      this.pending.clear();
    });
  }

  static async connect(port, child) {
    const started = Date.now();
    let target = null;
    while (Date.now() - started < 20_000) {
      if (child.exitCode !== null) {
        throw new Error(`Grok Desktop exited before a page target was available (${child.exitCode}).`);
      }
      try {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
        target = targets.find((candidate) => candidate.type === "page") ?? null;
        if (target?.webSocketDebuggerUrl) break;
      } catch {
        // The CDP HTTP endpoint can lag behind DevToolsActivePort creation.
      }
      await delay(100);
    }
    if (!target?.webSocketDebuggerUrl) throw new Error("Timed out waiting for Electron page target.");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await Promise.race([
      once(socket, "open"),
      delay(10_000).then(() => { throw new Error("Timed out opening Electron CDP WebSocket."); }),
    ]);
    return new CdpClient(socket);
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP method ${method}.`));
      }, 50_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  }

  async captureScreenshot(targetPath) {
    const capture = await this.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    await writeFile(targetPath, Buffer.from(capture.data, "base64"));
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function waitForChildSpawn(child) {
  if (child.pid) return;
  if (child.exitCode !== null) {
    throw new Error(`Grok Desktop failed to start (${child.exitCode}).`);
  }
  await Promise.race([
    once(child, "spawn"),
    delay(10_000).then(() => { throw new Error("Timed out starting Grok Desktop."); }),
  ]);
}

async function waitForProcessExit(child, timeoutMs) {
  if (!child.pid || child.exitCode !== null) return true;
  return Promise.race([
    once(child, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

async function terminateProcessTree(pid) {
  if (!pid) return;
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await once(killer, "exit");
}

async function requireRegularFile(targetPath, label) {
  await access(targetPath);
  const info = await stat(targetPath);
  if (!info.isFile()) throw new Error(`${label} is not a file: ${targetPath}`);
}

async function requireDirectory(targetPath, label) {
  await access(targetPath);
  const info = await stat(targetPath);
  if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${targetPath}`);
}

function assertSafeTemporaryUserDataPath(targetPath) {
  const resolvedTemp = path.resolve(os.tmpdir());
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedTemp, resolvedTarget);
  assert.equal(
    relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative),
    true,
    `Refusing to manage userData outside the system temp directory: ${resolvedTarget}`,
  );
  assert.equal(
    path.basename(resolvedTarget).startsWith("grok-desktop-smoke-"),
    true,
    `Refusing to manage an unexpected temp directory: ${resolvedTarget}`,
  );
}

await main();
