import path from "node:path";

import * as pty from "node-pty";

import type { DesktopEvent, TerminalStartRequest } from "../shared/contracts.js";

const MAX_BUFFERED_OUTPUT = 256 * 1024;
const OUTPUT_BATCH_DELAY_MS = 8;

type WindowsHiddenPtyOptions = pty.IWindowsPtyForkOptions & {
  // node-pty's public typings do not currently expose this option. Keeping it
  // explicit is harmless for ConPTY (which is already headless) and allows
  // backends that support the Node spawn option to honor it.
  windowsHide: true;
};

export class TerminalManager {
  readonly #emit: (event: DesktopEvent) => void;
  #process: pty.IPty | null = null;
  #dataDisposable: pty.IDisposable | null = null;
  #exitDisposable: pty.IDisposable | null = null;
  #outputBuffer = "";
  #flushTimer: NodeJS.Timeout | null = null;

  constructor(emit: (event: DesktopEvent) => void) {
    this.#emit = emit;
  }

  get active(): boolean {
    return this.#process !== null;
  }

  start(request: TerminalStartRequest & { executablePath: string }): void {
    if (this.#process) {
      throw new Error("原始终端已经在运行。");
    }
    if (!path.isAbsolute(request.workspacePath) || !path.isAbsolute(request.executablePath)) {
      throw new Error("终端只能使用经过验证的绝对路径启动。");
    }

    const options: WindowsHiddenPtyOptions = {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd: request.workspacePath,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
      encoding: "utf8",
      useConpty: process.platform === "win32",
      windowsHide: true,
    };

    // Passing the executable and argv separately is deliberate: node-pty
    // launches Grok directly, without cmd.exe, PowerShell, or interpolation.
    const terminalProcess = pty.spawn(request.executablePath, [], options);
    this.#process = terminalProcess;

    this.#dataDisposable = terminalProcess.onData((data) => {
      this.#queueOutput(data);
    });
    this.#exitDisposable = terminalProcess.onExit(({ exitCode }) => {
      this.#flushOutput();
      this.#disposeProcessHandles();
      this.#emit({ type: "terminal-exit", exitCode });
    });
  }

  write(data: string): void {
    const terminalProcess = this.#requireProcess();
    terminalProcess.write(data);
  }

  resize(cols: number, rows: number): void {
    const terminalProcess = this.#requireProcess();
    terminalProcess.resize(cols, rows);
  }

  stop(): void {
    const terminalProcess = this.#process;
    if (!terminalProcess) {
      this.#clearFlushTimer();
      this.#outputBuffer = "";
      return;
    }

    this.#flushOutput();
    this.#disposeProcessHandles();
    try {
      terminalProcess.kill();
    } catch {
      // The child may have exited between the active check and kill().
    }
  }

  #requireProcess(): pty.IPty {
    if (!this.#process) {
      throw new Error("原始终端尚未启动。");
    }
    return this.#process;
  }

  #queueOutput(data: string): void {
    this.#outputBuffer += data;
    if (this.#outputBuffer.length >= MAX_BUFFERED_OUTPUT) {
      this.#flushOutput();
      return;
    }

    if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => this.#flushOutput(), OUTPUT_BATCH_DELAY_MS);
    }
  }

  #flushOutput(): void {
    this.#clearFlushTimer();
    if (!this.#outputBuffer) {
      return;
    }

    const data = this.#outputBuffer;
    this.#outputBuffer = "";
    this.#emit({ type: "terminal-data", data });
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
  }

  #disposeProcessHandles(): void {
    this.#dataDisposable?.dispose();
    this.#exitDisposable?.dispose();
    this.#dataDisposable = null;
    this.#exitDisposable = null;
    this.#process = null;
  }
}
