import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { recordJournalTokens, resizeAgent, subscribeAgentSession, writeAgent } from "../lib/bridge";

interface AgentTerminalProps {
  sessionId: string;
  active: boolean;
  onExit: () => void;
  // Called whenever the terminal detects a token report line in the
  // agent's output. The handler is responsible for persisting the totals
  // to the project journal so they survive an app restart.
  onTokenUsage?: (input: number, output: number, note: string) => void;
  // Called when the agent starts/stops producing output so the sidebar
  // spinner reflects actual activity instead of spinning forever.
  onActivityChange?: (active: boolean) => void;
}

// Common shapes agent CLIs print when summarising a turn. We keep the
// regexes permissive on whitespace and decimal suffixes ("1.2k", "3.4M")
// because Claude Code, Codex, Kimi and Hermes each format the report
// slightly differently. The matcher runs over the last ~256 chars of the
// terminal scrollback to find the most recent report — agents sometimes
// print several intermediate lines before the final summary.
const TOKEN_PATTERNS: RegExp[] = [
  // "Tokens: 1.2k in, 234 out" / "Tokens used: 1000 in / 234 out"
  /tokens(?:\s+used)?\s*[:=]?\s*([\d.,]+)\s*(k|m)?\s*(?:input|in)[^\d]+([\d.,]+)\s*(k|m)?\s*(?:output|out)/i,
  // "input: 1000  output: 234" (no prefix)
  /input[^\d]*([\d.,]+)\s*(k|m)?[^\d]+output[^\d]*([\d.,]+)\s*(k|m)?/i,
  // "Total tokens: 1234 (input 1000, output 234)"
  /total\s+tokens[^\d]*[\d.,]+\s*(?:k|m)?\s*\(\s*input\s*([\d.,]+)\s*(k|m)?[^\d,]+output\s*([\d.,]+)\s*(k|m)?/i,
];

function parseCount(raw: string, suffix: string | undefined): number {
  const cleaned = raw.replace(/,/g, "");
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return 0;
  switch ((suffix || "").toLowerCase()) {
    case "k": return Math.round(value * 1_000);
    case "m": return Math.round(value * 1_000_000);
    default: return Math.round(value);
  }
}

function detectTokenUsage(scrollback: string): { input: number; output: number; matched: string } | null {
  for (const pattern of TOKEN_PATTERNS) {
    const match = pattern.exec(scrollback);
    if (!match) continue;
    const input = parseCount(match[1], match[2]);
    const output = parseCount(match[3], match[4]);
    if (input === 0 && output === 0) continue;
    return { input, output, matched: match[0].trim() };
  }
  return null;
}

export function AgentTerminal({ sessionId, active, onExit, onTokenUsage, onActivityChange }: AgentTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onExitRef = useRef(onExit);
  const onTokenUsageRef = useRef(onTokenUsage);
  const onActivityChangeRef = useRef(onActivityChange);
  onExitRef.current = onExit;
  onTokenUsageRef.current = onTokenUsage;
  onActivityChangeRef.current = onActivityChange;
  // Remember the last values we reported so we don't spam the journal on
  // every output chunk that happens to match the regex. Agents print the
  // same totals many times as context scrolls.
  const lastReportRef = useRef<string>("");
  // Track whether the agent is currently producing output so the sidebar
  // spinner only shows during active work, not while idle waiting for input.
  const activityActiveRef = useRef(false);
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      convertEol: false,
      allowProposedApi: false,
      fontFamily: '"Cascadia Code", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.22,
      scrollback: 20_000,
      theme: {
        background: "#0b0d10",
        foreground: "#d6d9de",
        cursor: "#d6d9de",
        selectionBackground: "#3a4657",
        black: "#111318",
        red: "#d66f6f",
        green: "#7fb58a",
        yellow: "#c5a36a",
        blue: "#7f9cc7",
        magenta: "#ae83b8",
        cyan: "#70abb0",
        white: "#d6d9de",
        brightBlack: "#646b75",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;

    const inputDisposable = terminal.onData((data) => {
      void writeAgent(sessionId, data).catch((error) => terminal.writeln(`\r\n[ADE] ${String(error)}`));
    });
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      void resizeAgent(sessionId, cols, rows).catch(() => undefined);
    });
    const observer = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
    });
    observer.observe(host);

    const unsubscribe = subscribeAgentSession(sessionId, {
      onOutput: (data) => {
        terminal.write(data);
        // Only flip the sidebar spinner on when the chunk carries real
        // content. Pure cursor moves / blank lines / lone escape sequences
        // shouldn't count as "agent is working" — they keep firing while
        // the agent is idle waiting for user input, which made the spinner
        // appear stuck "执行中" even when no task was running.
        const stripped = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
        const hasContent = stripped.replace(/\s+/g, "").length > 0;
        if (hasContent && !activityActiveRef.current) {
          activityActiveRef.current = true;
          onActivityChangeRef.current?.(true);
        }
        if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
        activityTimerRef.current = setTimeout(() => {
          activityActiveRef.current = false;
          onActivityChangeRef.current?.(false);
        }, 3000);
        // xterm's `buffer.active` is the live scrollback. Reading 256
        // lines is enough to cover most reports; larger logs are scanned
        // in the next chunk anyway. The `stripped` variable was already
        // declared above for the activity check; reuse it here for the
        // token-report regex so we don't double-declare the same value.
        const lines: string[] = [];
        const buf = terminal.buffer.active;
        for (let i = Math.max(0, buf.length - 256); i < buf.length; i += 1) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        const combined = stripped + "\n" + lines.join("\n");
        const report = detectTokenUsage(combined);
        if (report && report.matched !== lastReportRef.current) {
          lastReportRef.current = report.matched;
          onTokenUsageRef.current?.(report.input, report.output, report.matched);
        }
      },
      onExit: () => {
        if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
        activityActiveRef.current = false;
        onActivityChangeRef.current?.(false);
        terminal.writeln("\r\n\x1b[90m[ADE] Agent 进程已结束\x1b[0m");
        onExitRef.current();
      },
    });

    requestAnimationFrame(() => fit.fit());
    terminal.focus();
    return () => {
      unsubscribe();
      observer.disconnect();
      inputDisposable.dispose();
      resizeDisposable.dispose();
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      terminalRef.current?.focus();
    });
  }, [active]);

  return <div className={`agent-terminal ${active ? "is-active" : ""}`} ref={hostRef} />;
}

// Standalone helper kept exported so unit tests / debug tooling can reuse
// the regex set without spinning up an xterm instance.
export const _detectTokenUsage = detectTokenUsage;
export const _recordJournalTokens = recordJournalTokens;