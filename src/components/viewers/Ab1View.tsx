import { useEffect, useMemo, useRef } from "react";
import type { Annotation, FilePayload, TextSelectionContext } from "../../types/domain";
import { decodeBase64ToBytes, parseAb1 } from "./ab1";

interface Ab1ViewProps {
  payload: FilePayload;
  onSelection: (selection: TextSelectionContext) => void;
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

const CHANNEL_COLORS = {
  A: "#7fbf7f",
  C: "#7faecf",
  G: "#c8a868",
  T: "#d18a6a",
} as const;

// Layout constants for the chromatogram canvas. We use a fixed pixel height
// and let the trace auto-scale to fit; the width is the container's
// available width so the trace fills the viewport.
const CHART_PADDING_X = 12;
const CHART_PADDING_TOP = 6;
const CHART_PADDING_BOTTOM = 18;

export default function Ab1View({ payload, onSelection }: Ab1ViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // Parse the ABIF container once per payload change. Errors surface inline
  // so the user understands why the chromatogram is missing.
  const parsed = useMemo(() => {
    if (payload.encoding !== "base64") {
      return { error: "AB1 文件必须以二进制读取" };
    }
    try {
      const bytes = decodeBase64ToBytes(payload.content);
      return { record: parseAb1(bytes) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [payload.content, payload.encoding]);

  // Auto-scale each render so the four traces fill the canvas height.
  useEffect(() => {
    if (!canvasRef.current || !hostRef.current) return;
    if ("error" in parsed) return;
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = host.clientWidth - 24; // account for inner padding
    const cssHeight = 240;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.width = Math.max(1, Math.floor(cssWidth * dpr));
    canvas.height = Math.max(1, Math.floor(cssHeight * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChromatogram(ctx, cssWidth, cssHeight, { ...parsed.record });
  }, [parsed]);

  if ("error" in parsed) {
    return (
      <div className="viewer-state viewer-state--error">
        <strong>无法解析 AB1 文件</strong>
        <span>{parsed.error}</span>
        <span className="viewer-state-hint">
          请确认这是 Applied Biosystems 测序仪导出的 .ab1 文件。如提示 “缺少标签”，可重新导出原始 .ab1，或用 SnapGene / Chromas / seqkit 转为 FASTA 后打开。
        </span>
      </div>
    );
  }

  const record = parsed.record;
  const traceLength = Math.max(
    record.channels.A.length,
    record.channels.C.length,
    record.channels.G.length,
    record.channels.T.length,
  );
  // Average quality in the 0..60 range is what most ABI Sanger runs achieve;
  // we surface the mean so the user can scan whether a read is high-quality
  // overall before drilling into the chromatogram.
  const avgQuality = record.qualities.length > 0
    ? Math.round(record.qualities.reduce((sum, value) => sum + value, 0) / record.qualities.length)
    : undefined;
  // Show which DATA<n> tag each base mapped to. Most files use 9..12 but
  // some sequencer exports offset the numbering — surfacing this keeps the
  // mapping auditable.
  const channelTagSummary = (() => {
    const parts: string[] = [];
    for (const base of ["A", "C", "G", "T"] as const) {
      const tag = record.channelTagFor[base];
      if (tag !== undefined) parts.push(`${base}=DATA${tag}`);
    }
    return parts.join(" · ");
  })();

  const captureSelection = () => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    if (!text || !hostRef.current?.contains(selection?.anchorNode ?? null)) return;
    onSelection({
      filePath: payload.relativePath,
      selectedText: text,
      prefix: "",
      suffix: "",
      fileModifiedMs: payload.modifiedMs,
    });
  };

  return (
    <div className="ab1-view" ref={hostRef} onMouseUp={captureSelection}>
      <div className="ab1-summary">
        <div>
          <span>AB1</span>
          <strong>{record.sample || "(未命名样品)"}</strong>
        </div>
        <div>
          <em>{record.bases.length.toLocaleString("en-US")} bases</em>
          <span>峰位 {record.peakLocations.length} · 通道采样 {traceLength.toLocaleString("en-US")}</span>
          {avgQuality !== undefined && <span>平均质量 {avgQuality}</span>}
          {channelTagSummary && <span>通道映射 {channelTagSummary}</span>}
        </div>
        <div className="ab1-meta">
          {record.machine && <span>仪器：{record.machine}</span>}
          {record.analysisVersion && <span>分析：{record.analysisVersion}</span>}
        </div>
      </div>
      <div className="ab1-canvas-wrap">
        <canvas ref={canvasRef} className="ab1-canvas" />
      </div>
      <div className="ab1-bases">
        <pre className="ab1-bases-body" onMouseUp={captureSelection}>{record.bases}</pre>
      </div>
      {record.comment && (
        <div className="ab1-comment">
          <strong>注释</strong>
          <span>{record.comment}</span>
        </div>
      )}
    </div>
  );
}

interface DrawArgs {
  channels: { A: number[]; C: number[]; G: number[]; T: number[] };
  peakLocations: number[];
  bases: string;
}

function drawChromatogram(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  record: DrawArgs & { qualities?: number[] },
) {
  const { channels, peakLocations, bases, qualities } = record;
  const usableWidth = width - CHART_PADDING_X * 2;
  const usableHeight = height - CHART_PADDING_TOP - CHART_PADDING_BOTTOM;
  const traceLength = Math.max(
    channels.A.length, channels.C.length, channels.G.length, channels.T.length,
  );
  if (traceLength === 0 || usableWidth <= 0 || usableHeight <= 0) return;

  // Scale: x maps sample index to pixel; y maps intensity to pixel (top = max).
  const xScale = (sampleIndex: number) => CHART_PADDING_X + (sampleIndex / traceLength) * usableWidth;
  const baselineY = CHART_PADDING_TOP + usableHeight;

  // Background + baseline rule.
  ctx.fillStyle = "#0e1013";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#232830";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CHART_PADDING_X, baselineY);
  ctx.lineTo(width - CHART_PADDING_X, baselineY);
  ctx.stroke();

  // Draw each channel as a stacked fill from the baseline up to the peak
  // amplitude. Drawing fills rather than lines matches how Sequencher /
  // Chromas / FinchTV render chromatograms and lets the user read the
  // actual peak shape clearly.
  const orderedChannels: Array<{ key: keyof DrawArgs["channels"]; color: string }> = [
    { key: "G", color: CHANNEL_COLORS.G },
    { key: "A", color: CHANNEL_COLORS.A },
    { key: "T", color: CHANNEL_COLORS.T },
    { key: "C", color: CHANNEL_COLORS.C },
  ];

  // Step down to 1px per bucket on the visible canvas so we don't burn
  // time drawing thousands of off-screen segments.
  const step = Math.max(1, Math.ceil(traceLength / usableWidth));

  for (const { key, color } of orderedChannels) {
    const samples = channels[key];
    if (samples.length === 0) continue;
    let max = 0;
    for (const value of samples) if (value > max) max = value;
    if (max <= 0) max = 1;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(CHART_PADDING_X, baselineY);
    for (let pixel = 0; pixel < usableWidth; pixel += 1) {
      const sampleIndex = Math.floor((pixel / usableWidth) * traceLength);
      const value = samples[sampleIndex] ?? 0;
      const normalized = Math.max(0, Math.min(1, value / max));
      const x = CHART_PADDING_X + pixel;
      const y = baselineY - normalized * usableHeight;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width - CHART_PADDING_X, baselineY);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Quality bars (one per called base). The bar height is proportional to
  // the per-base quality score normalised against the 0..255 PCON range,
  // and the colour shifts from red (low Q) to green (high Q) so users can
  // scan quality at a glance. We draw them as thin vertical columns at
  // each peak position above the chromatogram baseline.
  if (qualities && qualities.length === peakLocations.length) {
    const barTopY = CHART_PADDING_TOP + 18; // leave room for the base letters
    const barHeight = 6;
    for (let index = 0; index < peakLocations.length; index += 1) {
      const sample = peakLocations[index];
      if (sample >= traceLength) continue;
      const q = Math.max(0, Math.min(255, qualities[index] ?? 0));
      const normalised = q / 255;
      const x = xScale(sample);
      const h = Math.max(1, normalised * barHeight);
      ctx.fillStyle = qualityColor(q);
      ctx.fillRect(x - 1, barTopY + (barHeight - h), 2, h);
    }
  }

  // Draw base calls as letters above each peak location.
  const baseColor: Record<string, string> = {
    A: CHANNEL_COLORS.A,
    C: CHANNEL_COLORS.C,
    G: CHANNEL_COLORS.G,
    T: CHANNEL_COLORS.T,
  };
  ctx.font = "11px 'Cascadia Code', monospace";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "center";
  for (let index = 0; index < peakLocations.length; index += 1) {
    const sample = peakLocations[index];
    if (sample >= traceLength) continue;
    const letter = bases[index] ?? "N";
    const color = baseColor[letter] ?? "#8b919a";
    const x = xScale(sample);
    ctx.fillStyle = color;
    ctx.fillText(letter, x, CHART_PADDING_TOP + 14);
    ctx.strokeStyle = "rgba(139,145,154,.18)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, CHART_PADDING_TOP + 16);
    ctx.lineTo(x, baselineY);
    ctx.stroke();
  }

  // Axis labels along the bottom — use base positions rather than raw trace
  // indices so the user can read "base N" directly off the chart.
  ctx.fillStyle = "#5f666f";
  ctx.font = "9px 'Cascadia Code', monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  const tickCount = 8;
  // Map each tick to the nearest base position via the peak index array.
  for (let index = 0; index <= tickCount; index += 1) {
    const fraction = index / tickCount;
    const basePosition = Math.min(
      bases.length - 1,
      Math.max(0, Math.round(fraction * (bases.length - 1))),
    );
    const sample = peakLocations[basePosition] ?? Math.round(fraction * traceLength);
    const x = xScale(sample);
    ctx.fillText((basePosition + 1).toLocaleString("en-US"), x - 14, baselineY + 4);
  }
}

// Map a Phred-like quality score (0..255) to a colour that runs from red
// (low) through amber to green (high). Mirrors the visual cues used by
// Chromas / FinchTV so users can spot low-Q regions at a glance.
function qualityColor(score: number): string {
  const t = Math.max(0, Math.min(1, score / 60)); // 0..60 covers the typical quality range
  if (t < 0.33) return "#c57474";
  if (t < 0.66) return "#c8a868";
  return "#7fbf7f";
}