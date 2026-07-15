import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { AlertIcon, RefreshIcon, TerminalIcon } from "./Icons";
import { userFacingErrorMessage } from "../lib/user-facing-error";

let terminalMountEpoch = 0;

interface TerminalPanelProps {
  workspacePath: string;
  executablePath?: string | null;
  onNotice(message: string, level?: "info" | "warning" | "error"): void;
}

export function TerminalPanel({ workspacePath, executablePath, onNotice }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [exitCode, setExitCode] = useState<number | null | undefined>(undefined);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const mountEpoch = ++terminalMountEpoch;
    let disposed = false;
    let started = false;
    let resizeTimer: number | undefined;
    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13.5,
      lineHeight: 1.34,
      scrollback: 8000,
      theme: {
        background: "#0d0e0f",
        foreground: "#d8d6cf",
        cursor: "#e55c54",
        cursorAccent: "#0d0e0f",
        selectionBackground: "#4d525b88",
        black: "#17191b",
        red: "#e55c54",
        green: "#89aa84",
        yellow: "#c6a96b",
        blue: "#7f9db8",
        magenta: "#a28cab",
        cyan: "#76a9a6",
        white: "#d8d6cf",
        brightBlack: "#74777b",
        brightRed: "#f07870",
        brightGreen: "#a4c49f",
        brightYellow: "#dcc286",
        brightBlue: "#9ab8d1",
        brightMagenta: "#bda5c5",
        brightCyan: "#91c2bf",
        brightWhite: "#f3f0e8",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    fitAddon.fit();
    terminal.focus();
    terminalRef.current = terminal;

    const start = async () => {
      try {
        await window.grokDesktop.startTerminal({
          workspacePath,
          ...(executablePath ? { executablePath } : {}),
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (disposed) {
          if (mountEpoch === terminalMountEpoch) await window.grokDesktop.stopTerminal();
          return;
        }
        if (mountEpoch === terminalMountEpoch) {
          started = true;
          setExitCode(undefined);
        }
      } catch (error) {
        if (!disposed) onNotice(userFacingErrorMessage(error, "原始终端启动失败"), "error");
      }
    };

    const inputDisposable = terminal.onData((data) => {
      void window.grokDesktop.writeTerminal(data).catch((error: unknown) => {
        onNotice(userFacingErrorMessage(error, "终端输入发送失败"), "error");
      });
    });

    const unsubscribe = window.grokDesktop.onEvent((envelope) => {
      const event = envelope.event;
      if (event.type === "terminal-data") terminal.write(event.data);
      if (event.type === "terminal-exit") setExitCode(event.exitCode);
    });

    const observer = new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
          if (started) void window.grokDesktop.resizeTerminal({ cols: terminal.cols, rows: terminal.rows });
        } catch {
          // The terminal may be tearing down while ResizeObserver flushes.
        }
      }, 60);
    });
    observer.observe(container);
    void start();

    return () => {
      disposed = true;
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      unsubscribe();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      if (started && mountEpoch === terminalMountEpoch) void window.grokDesktop.stopTerminal();
    };
  }, [workspacePath, executablePath, generation, onNotice]);

  return (
    <section className="terminal-panel" aria-label="Grok 原始终端">
      <header className="terminal-panel__header">
        <div>
          <TerminalIcon size={16} />
          <span>原始终端</span>
          <span className="terminal-panel__path">{workspacePath}</span>
        </div>
        <span>完整 CLI 兼容模式</span>
      </header>
      <div className="terminal-panel__body" ref={containerRef} />
      {exitCode !== undefined && (
        <div className="terminal-exit" role="status">
          <AlertIcon size={18} />
          <div><strong>Grok 进程已结束</strong><span>退出码：{exitCode ?? "未知"}</span></div>
          <button onClick={() => setGeneration((value) => value + 1)} type="button"><RefreshIcon size={15} />重新启动</button>
        </div>
      )}
    </section>
  );
}
