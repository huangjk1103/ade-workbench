import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { Annotation, FilePayload, TextSelectionContext } from "../../types/domain";
import { hexPreview, parseDna, translate, type DnaDocument, type DnaFeature } from "./dna";

interface DnaViewProps {
  payload: FilePayload;
  onSelection: (selection: TextSelectionContext) => void;
  pendingJump?: Annotation | null;
  onJumpMissed?: (annotation: Annotation) => void;
}

// Width options for the left-pane sequence / translation grid. These mirror
// common viewing widths in SnapGene / Geneious and are large enough that
// three lines of nucleotides stack nicely without horizontal scrolling.
const LINE_WIDTHS = [60, 100, 150, 200] as const;
const SEARCH_LIMIT = 500;

const NUCLEOTIDE_COLORS: Record<string, string> = {
  A: "#69c37b",
  T: "#d78962",
  U: "#d78962",
  G: "#c6a35a",
  C: "#6fb6d6",
  N: "#6c7480",
};

const FEATURE_FALLBACK = "#7faecf";

type Range = { start: number; end: number };
type SearchResult =
  | { kind: "sequence"; label: string; start: number; end: number }
  | { kind: "feature"; label: string; start: number; end: number; featureIndex: number };

interface IndexedFeature {
  feature: DnaFeature;
  index: number;
}

export default function DnaView({ payload, onSelection, onOpenExternal }: DnaViewProps & { onOpenExternal?: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [lineWidth, setLineWidth] = useState<(typeof LINE_WIDTHS)[number]>(100);

  const result = useMemo(async () => {
    if (payload.encoding !== "base64") {
      return { attempts: [], document: null as DnaDocument | null, raw: "" };
    }
    return parseDna(payload.content);
  }, [payload.content, payload.encoding]);

  const [state, setState] = useState<Awaited<typeof result>>({ attempts: [], document: null, raw: "" });
  useEffect(() => {
    let active = true;
    void result.then((resolved) => { if (active) setState(resolved); });
    return () => { active = false; };
  }, [result]);

  const hex = useMemo(() => {
    if (payload.encoding !== "base64") return "";
    // Decode just enough for a short hex preview.
    try {
      const slice = payload.content.slice(0, 24);
      const binary = atob(slice);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return hexPreview(bytes, 16);
    } catch { return ""; }
  }, [payload.content, payload.encoding]);

  if (payload.encoding !== "base64") {
    return (
      <div className="viewer-state viewer-state--error">
        <strong>无法读取 SnapGene 文件</strong>
        <span>需要以二进制读取，但实际收到 UTF-8 文本。</span>
      </div>
    );
  }

  if (!state.document) {
    return (
      <div className="viewer-state viewer-state--error">
        <strong>未识别的 SnapGene 格式</strong>
        <span>{payload.relativePath}</span>
        <span className="viewer-state-hint">
          前 16 字节：<code>{hex || "(空)"}</code>
        </span>
        <span className="viewer-state-hint">
          尝试过的解码策略：
          <ul>
            {state.attempts.map((attempt) => (
              <li key={attempt.name}>
                <strong>{attempt.name}</strong> — {attempt.error ?? "失败"}
              </li>
            ))}
          </ul>
        </span>
        {onOpenExternal && (
          <button type="button" onClick={onOpenExternal}>使用系统程序打开</button>
        )}
      </div>
    );
  }

  return (
    <DnaDocumentView
      document={state.document}
      payload={payload}
      onSelection={onSelection}
      hostRef={hostRef}
      lineWidth={lineWidth}
      setLineWidth={setLineWidth}
    />
  );
}

interface DnaDocumentViewProps {
  document: DnaDocument;
  payload: FilePayload;
  onSelection: (selection: TextSelectionContext) => void;
  hostRef: RefObject<HTMLDivElement | null>;
  lineWidth: (typeof LINE_WIDTHS)[number];
  setLineWidth: (value: (typeof LINE_WIDTHS)[number]) => void;
}

function DnaDocumentView({ document: doc, payload, onSelection, hostRef, lineWidth, setLineWidth }: DnaDocumentViewProps) {
  const sequenceRowsRef = useRef<HTMLDivElement>(null);
  const [selectedFeatureIndex, setSelectedFeatureIndex] = useState<number | null>(doc.features.length > 0 ? 0 : null);
  const [hoveredFeatureIndex, setHoveredFeatureIndex] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
  const [focusPosition, setFocusPosition] = useState(1);
  const [mapRotation, setMapRotation] = useState(0);
  const [mapZoom, setMapZoom] = useState(1);
  const [showLabels, setShowLabels] = useState(true);
  const [showTranslation, setShowTranslation] = useState(true);
  const [copiedLabel, setCopiedLabel] = useState("");
  const [jumpText, setJumpText] = useState("1");
  const [mapMode, setMapMode] = useState<"circular" | "linear">(doc.topology === "circular" ? "circular" : "linear");

  useEffect(() => {
    setSelectedFeatureIndex(doc.features.length > 0 ? 0 : null);
    setHoveredFeatureIndex(null);
    setQuery("");
    setCurrentSearchIndex(0);
    setFocusPosition(1);
    setJumpText("1");
    setMapRotation(0);
    setMapZoom(1);
    setMapMode(doc.topology === "circular" ? "circular" : "linear");
  }, [doc]);

  const indexedFeatures = useMemo<IndexedFeature[]>(
    () => doc.features.map((feature, index) => ({ feature, index })),
    [doc.features],
  );
  const showCircular = mapMode === "circular";
  // When a circular plasmid is unrolled into a linear map, any feature whose
  // end < start crosses the origin and would otherwise disappear off the right
  // edge of the axis. Split those features into two segments so the full
  // annotation is still visible in the linear lane.
  const linearFeatures = useMemo<IndexedFeature[]>(
    () => (showCircular || doc.topology !== "circular"
      ? indexedFeatures
      : expandCircularFeatures(indexedFeatures, doc.sequence.length)),
    [indexedFeatures, showCircular, doc.topology, doc.sequence.length],
  );
  const selectedFeature = selectedFeatureIndex == null ? null : doc.features[selectedFeatureIndex] ?? null;
  const lines = useMemo(() => chunk(doc.sequence, lineWidth), [doc.sequence, lineWidth]);
  const proteinLines = useMemo(() => {
    if (!showTranslation) return [];
    const protein = translate(doc.sequence);
    return chunk(protein, Math.floor(lineWidth / 3));
  }, [doc.sequence, lineWidth, showTranslation]);
  const gc = useMemo(() => gcPercent(doc.sequence), [doc.sequence]);
  const searchResults = useMemo(() => buildSearchResults(doc, query), [doc, query]);
  const activeSearch = searchResults[currentSearchIndex] ?? null;
  const activeRange: Range | null = activeSearch
    ? { start: activeSearch.start, end: activeSearch.end }
    : selectedFeature
      ? { start: selectedFeature.start, end: selectedFeature.end }
      : { start: focusPosition, end: focusPosition };
  const searchRanges = useMemo(
    () => searchResults.filter((item): item is Extract<SearchResult, { kind: "sequence" }> => item.kind === "sequence").map((item) => ({ start: item.start, end: item.end })),
    [searchResults],
  );

  useEffect(() => {
    if (searchResults.length === 0) {
      setCurrentSearchIndex(0);
      return;
    }
    setCurrentSearchIndex((value) => Math.min(value, searchResults.length - 1));
  }, [searchResults.length]);

  useEffect(() => {
    if (!activeSearch) return;
    setFocusPosition(activeSearch.start);
    setJumpText(String(activeSearch.start));
    if (activeSearch.kind === "feature") setSelectedFeatureIndex(activeSearch.featureIndex);
  }, [activeSearch]);

  useEffect(() => {
    const range = activeRange;
    if (!range || !sequenceRowsRef.current) return;
    const rowIndex = Math.floor((clamp(range.start, 1, doc.sequence.length) - 1) / lineWidth);
    const row = sequenceRowsRef.current.querySelector<HTMLElement>(`[data-row-index="${rowIndex}"]`);
    row?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeRange?.start, doc.sequence.length, lineWidth]);

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

  const copyText = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopiedLabel(label);
      window.setTimeout(() => setCopiedLabel(""), 1400);
    }).catch(() => undefined);
  };

  const selectFeature = (index: number | null) => {
    setSelectedFeatureIndex(index);
    if (index == null) return;
    const feature = doc.features[index];
    if (!feature) return;
    setFocusPosition(feature.start);
    setJumpText(String(feature.start));
  };

  const jumpToPosition = (position: number) => {
    const clamped = clamp(Math.round(position), 1, doc.sequence.length);
    setFocusPosition(clamped);
    setSelectedFeatureIndex(null);
    setCurrentSearchIndex(0);
    setJumpText(String(clamped));
  };

  const submitJump = () => {
    const parsed = Number.parseInt(jumpText.replace(/[,\s]/g, ""), 10);
    if (Number.isFinite(parsed)) jumpToPosition(parsed);
  };

  const previousSearch = () => {
    if (searchResults.length === 0) return;
    setCurrentSearchIndex((value) => (value - 1 + searchResults.length) % searchResults.length);
  };

  const nextSearch = () => {
    if (searchResults.length === 0) return;
    setCurrentSearchIndex((value) => (value + 1) % searchResults.length);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.name === "dna-search") {
      event.preventDefault();
      if (event.shiftKey) previousSearch();
      else nextSearch();
    }
  };

  return (
    <div className="dna-view" ref={hostRef} onMouseUp={captureSelection} onKeyDown={handleKeyDown}>
      <div className="dna-summary dna-summary--interactive">
        <div className="dna-brand-card">
          <span>SnapGene DNA · {doc.topology === "circular" ? "环状" : "线性"}{showCircular !== (doc.topology === "circular") ? ` · 视图 ${showCircular ? "环状" : "线性"}` : ""}</span>
          <strong>{doc.sequence.length.toLocaleString("en-US")} bp</strong>
        </div>
        <div>
          <span>FEATURES</span>
          <strong>{doc.features.length.toLocaleString("en-US")}</strong>
        </div>
        <div>
          <span>GC</span>
          <strong>{gc.toFixed(1)}%</strong>
        </div>
        <div className="dna-strategy-pill" title={doc.strategy}>{doc.strategy}</div>
        <div className="dna-summary-actions">
          {copiedLabel && <em>{copiedLabel}</em>}
          <button type="button" onClick={() => copyText("已复制全序列", doc.sequence)}>复制序列</button>
          <button type="button" onClick={() => copyText("已复制 FASTA", toFasta(payload.name, doc.sequence))}>复制 FASTA</button>
        </div>
      </div>

      <div className="dna-workbench">
        <section className="dna-map-card">
          <div className="dna-card-header">
            <div>
              <span>PLASMID MAP</span>
              <strong>{selectedFeature ? selectedFeature.name : `焦点 ${focusPosition.toLocaleString("en-US")} bp`}</strong>
            </div>
            <div className="dna-map-controls">
              <div className="dna-map-mode" role="group" aria-label="图谱视图">
                <button
                  type="button"
                  className={mapMode === "circular" ? "is-active" : ""}
                  onClick={() => setMapMode("circular")}
                  title={doc.topology === "circular" ? "环状图谱" : "强制以环状方式显示"}
                >环状</button>
                <button
                  type="button"
                  className={mapMode === "linear" ? "is-active" : ""}
                  onClick={() => setMapMode("linear")}
                  title={doc.topology === "linear" ? "线性图谱" : "展开为线性图谱（跨原点 feature 自动拆段）"}
                >线性</button>
              </div>
              <span className="dna-map-divider" aria-hidden="true" />
              <button type="button" onClick={() => setMapZoom((value) => clamp(value - 0.1, 0.72, 1.4))}>−</button>
              <span>{Math.round(mapZoom * 100)}%</span>
              <button type="button" onClick={() => setMapZoom((value) => clamp(value + 0.1, 0.72, 1.4))}>+</button>
              <button type="button" className={showLabels ? "is-active" : ""} onClick={() => setShowLabels((value) => !value)}>标签</button>
              <button type="button" onClick={() => setMapRotation(0)}>复位</button>
            </div>
          </div>
          {showCircular ? (
            <CircularPlasmidMap
              document={doc}
              features={indexedFeatures}
              selectedIndex={selectedFeatureIndex}
              hoveredIndex={hoveredFeatureIndex}
              activeRange={activeRange}
              rotation={mapRotation}
              zoom={mapZoom}
              showLabels={showLabels}
              onRotate={setMapRotation}
              onZoom={setMapZoom}
              onSelectFeature={selectFeature}
              onHoverFeature={setHoveredFeatureIndex}
              onFocusPosition={jumpToPosition}
            />
          ) : (
            <LinearDetailedMap
              document={doc}
              features={linearFeatures}
              selectedIndex={selectedFeatureIndex}
              hoveredIndex={hoveredFeatureIndex}
              activeRange={activeRange}
              onSelectFeature={selectFeature}
              onHoverFeature={setHoveredFeatureIndex}
              onFocusPosition={jumpToPosition}
            />
          )}
          <LinearOverview
            document={doc}
            features={linearFeatures}
            selectedIndex={selectedFeatureIndex}
            hoveredIndex={hoveredFeatureIndex}
            activeRange={activeRange}
            searchRanges={searchRanges}
            onSelectFeature={selectFeature}
            onHoverFeature={setHoveredFeatureIndex}
            onFocusPosition={jumpToPosition}
          />
        </section>

        <aside className="dna-inspector">
          <div className="dna-search-panel">
            <label>
              <span>SEARCH</span>
              <input
                name="dna-search"
                value={query}
                placeholder="序列 / feature 名称 / 类型"
                onChange={(event) => { setQuery(event.target.value); setCurrentSearchIndex(0); }}
              />
            </label>
            <div className="dna-search-actions">
              <button type="button" onClick={previousSearch} disabled={searchResults.length === 0}>上一个</button>
              <strong>{searchResults.length === 0 ? "0" : `${currentSearchIndex + 1} / ${searchResults.length}`}</strong>
              <button type="button" onClick={nextSearch} disabled={searchResults.length === 0}>下一个</button>
            </div>
            {activeSearch && (
              <button type="button" className="dna-current-hit" onClick={() => jumpToPosition(activeSearch.start)}>
                <span>{activeSearch.kind === "sequence" ? "SEQ" : "FEATURE"}</span>
                {activeSearch.label}
              </button>
            )}
          </div>

          <div className="dna-jump-panel">
            <label>
              <span>JUMP TO BP</span>
              <input
                value={jumpText}
                inputMode="numeric"
                onChange={(event) => setJumpText(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") submitJump(); }}
              />
            </label>
            <button type="button" onClick={submitJump}>定位</button>
          </div>

          <FeatureInspector
            document={doc}
            selectedFeature={selectedFeature}
            selectedIndex={selectedFeatureIndex}
            onCopy={copyText}
          />

          <div className="dna-feature-browser">
            <div className="dna-panel-title">
              <span>FEATURE TABLE</span>
              <strong>{doc.features.length}</strong>
            </div>
            <div className="dna-feature-list" role="listbox" aria-label="DNA features">
              {indexedFeatures.map(({ feature, index }) => {
                const selected = selectedFeatureIndex === index;
                const hovered = hoveredFeatureIndex === index;
                return (
                  <button
                    key={`${feature.name}-${index}`}
                    type="button"
                    className={`dna-feature-item${selected ? " is-selected" : ""}${hovered ? " is-hovered" : ""}`}
                    onClick={() => selectFeature(index)}
                    onMouseEnter={() => setHoveredFeatureIndex(index)}
                    onMouseLeave={() => setHoveredFeatureIndex(null)}
                  >
                    <i style={{ background: feature.color ?? FEATURE_FALLBACK }} />
                    <span>
                      <strong>{feature.name}</strong>
                      <em>{feature.type ?? "feature"} · {formatRange(feature)} · {featureLength(feature).toLocaleString("en-US")} bp</em>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="dna-sequence-card">
          <div className="dna-card-header dna-sequence-toolbar">
            <div>
              <span>SEQUENCE VIEW</span>
              <strong>{activeRange ? `${activeRange.start.toLocaleString("en-US")} – ${activeRange.end.toLocaleString("en-US")}` : "全序列"}</strong>
            </div>
            <div className="dna-line-width">
              <span>每行</span>
              {LINE_WIDTHS.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={lineWidth === value ? "is-active" : ""}
                  onClick={() => setLineWidth(value)}
                >
                  {value}
                </button>
              ))}
              <button type="button" className={showTranslation ? "is-active" : ""} onClick={() => setShowTranslation((value) => !value)}>AA</button>
            </div>
          </div>
          <div className="dna-sequence-pane" ref={sequenceRowsRef}>
            <div className="dna-sequence-labels">
              <span>position</span>
              <span>nucleotide</span>
              {showTranslation && <span>amino acid (+1)</span>}
            </div>
            <div className="dna-sequence-rows">
              {lines.map((line, index) => {
                const position = index * lineWidth + 1;
                const protein = proteinLines[index] ?? "";
                const rowEnd = position + line.length - 1;
                return (
                  <div className="dna-sequence-row" key={`row-${index}`} data-row-index={index}>
                    <div className="dna-sequence-position">
                      <em>{position.toLocaleString("en-US")}</em>
                      <small>{rowEnd.toLocaleString("en-US")}</small>
                    </div>
                    <div className="dna-sequence-letters">
                      <FeatureTrack
                        features={indexedFeatures}
                        rowStart={position}
                        rowEnd={rowEnd}
                        lineLength={line.length}
                        selectedIndex={selectedFeatureIndex}
                        hoveredIndex={hoveredFeatureIndex}
                        onSelectFeature={selectFeature}
                        onHoverFeature={setHoveredFeatureIndex}
                      />
                      <pre className="dna-bases">
                        {renderBases(line, indexedFeatures, position, selectedFeatureIndex, hoveredFeatureIndex, activeRange, searchRanges)}
                      </pre>
                      {showTranslation && <pre className="dna-protein">{protein}</pre>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function FeatureInspector({ document, selectedFeature, selectedIndex, onCopy }: {
  document: DnaDocument;
  selectedFeature: DnaFeature | null;
  selectedIndex: number | null;
  onCopy: (label: string, text: string) => void;
}) {
  if (!selectedFeature || selectedIndex == null) {
    return (
      <div className="dna-feature-detail dna-feature-detail--empty">
        <span>FEATURE DETAIL</span>
        <strong>未选择 feature</strong>
        <p>点击图谱、线性轨道或 feature 表格即可联动高亮并跳转到序列位置。</p>
      </div>
    );
  }
  const sequence = sliceFeatureSequence(document.sequence, selectedFeature);
  return (
    <div className="dna-feature-detail">
      <span>FEATURE DETAIL</span>
      <div className="dna-feature-detail-title">
        <i style={{ background: selectedFeature.color ?? FEATURE_FALLBACK }} />
        <strong>{selectedFeature.name}</strong>
      </div>
      <dl>
        <div><dt>类型</dt><dd>{selectedFeature.type ?? "—"}</dd></div>
        <div><dt>位置</dt><dd>{formatRange(selectedFeature)}</dd></div>
        <div><dt>长度</dt><dd>{featureLength(selectedFeature).toLocaleString("en-US")} bp</dd></div>
        <div><dt>方向</dt><dd>{selectedFeature.strand === -1 ? "反向" : selectedFeature.strand === 1 ? "正向" : "未指定"}</dd></div>
      </dl>
      <pre>{sequence.slice(0, 240)}{sequence.length > 240 ? "…" : ""}</pre>
      <div className="dna-feature-detail-actions">
        <button type="button" onClick={() => onCopy("已复制 feature 序列", sequence)}>复制序列</button>
        <button type="button" onClick={() => onCopy("已复制反向互补", reverseComplement(sequence))}>反向互补</button>
      </div>
    </div>
  );
}

function CircularPlasmidMap({
  document,
  features,
  selectedIndex,
  hoveredIndex,
  activeRange,
  rotation,
  zoom,
  showLabels,
  onRotate,
  onZoom,
  onSelectFeature,
  onHoverFeature,
  onFocusPosition,
}: {
  document: DnaDocument;
  features: IndexedFeature[];
  selectedIndex: number | null;
  hoveredIndex: number | null;
  activeRange: Range | null;
  rotation: number;
  zoom: number;
  showLabels: boolean;
  onRotate: (value: number | ((previous: number) => number)) => void;
  onZoom: (value: number | ((previous: number) => number)) => void;
  onSelectFeature: (index: number | null) => void;
  onHoverFeature: (index: number | null) => void;
  onFocusPosition: (position: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; lastAngle: number } | null>(null);
  const length = document.sequence.length;
  const size = 520;
  const cx = size / 2;
  const cy = size / 2;
  const baseRadius = 152 * zoom;
  const gcBins = useMemo(() => makeGcBins(document.sequence, 96), [document.sequence]);
  const visibleFeatures = features.slice(0, 160);

  const angleForEvent = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    return Math.atan2(y, x) * 180 / Math.PI;
  };

  const pointerToPosition = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - rect.width / 2;
    const y = event.clientY - rect.top - rect.height / 2;
    const degrees = (Math.atan2(y, x) * 180 / Math.PI - rotation + 450) % 360;
    return clamp(Math.round((degrees / 360) * length) + 1, 1, length);
  };

  const selectedMidAngle = activeRange ? rangeMidAngle(activeRange, length, rotation) : null;

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="dna-plasmid dna-plasmid--circular"
      role="img"
      aria-label="交互式环状质粒图谱"
      onClick={(event) => {
        if (event.target === event.currentTarget) onFocusPosition(pointerToPosition(event));
      }}
      onWheel={(event) => {
        event.preventDefault();
        const direction = event.deltaY > 0 ? -0.08 : 0.08;
        onZoom((previous) => clamp(previous + direction, 0.72, 1.4));
      }}
      onPointerDown={(event) => {
        dragRef.current = { pointerId: event.pointerId, lastAngle: angleForEvent(event) };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragRef.current) return;
        const angle = angleForEvent(event);
        const delta = angle - dragRef.current.lastAngle;
        dragRef.current.lastAngle = angle;
        onRotate((previous) => previous + delta);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { dragRef.current = null; }}
    >
      <defs>
        <radialGradient id="dna-map-glow" cx="50%" cy="48%" r="62%">
          <stop offset="0%" stopColor="#202733" />
          <stop offset="64%" stopColor="#12161c" />
          <stop offset="100%" stopColor="#0d1014" />
        </radialGradient>
        <filter id="dna-soft-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="8" floodColor="#000000" floodOpacity="0.35" />
        </filter>
      </defs>
      <rect
        x="0"
        y="0"
        width={size}
        height={size}
        rx="22"
        fill="url(#dna-map-glow)"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left - rect.width / 2;
          const y = event.clientY - rect.top - rect.height / 2;
          const degrees = (Math.atan2(y, x) * 180 / Math.PI - rotation + 450) % 360;
          onFocusPosition(clamp(Math.round((degrees / 360) * length) + 1, 1, length));
        }}
      />
      <circle cx={cx} cy={cy} r={baseRadius + 58} fill="none" stroke="#212a34" strokeWidth="1" strokeDasharray="2 8" />
      <circle cx={cx} cy={cy} r={baseRadius - 58} fill="none" stroke="#1b222b" strokeWidth="1" />

      {makeTicks(length, rotation).map((tick) => {
        const p1 = polar(cx, cy, baseRadius - (tick.major ? 52 : 44), tick.angle);
        const p2 = polar(cx, cy, baseRadius - 34, tick.angle);
        const label = polar(cx, cy, baseRadius - 72, tick.angle);
        return (
          <g key={tick.position}>
            <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={tick.major ? "#5b6470" : "#313943"} strokeWidth={tick.major ? 1.4 : 1} />
            {tick.major && (
              <text x={label.x} y={label.y} textAnchor="middle" dominantBaseline="middle" fill="#65707d" fontSize="9" fontFamily="Cascadia Code, monospace">
                {formatCompactBp(tick.position)}
              </text>
            )}
          </g>
        );
      })}

      <g opacity="0.7">
        {gcBins.map((bin, index) => {
          const angle = bin.angle + rotation;
          const inner = baseRadius - 30;
          const outer = inner + 4 + bin.value * 22;
          const p1 = polar(cx, cy, inner, angle);
          const p2 = polar(cx, cy, outer, angle);
          return <line key={index} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={bin.value >= 0.5 ? "#79d3a1" : "#d2a65f"} strokeWidth="2" strokeLinecap="round" />;
        })}
      </g>

      <circle cx={cx} cy={cy} r={baseRadius} fill="none" stroke="#56606d" strokeWidth="5" filter="url(#dna-soft-shadow)" />
      <circle cx={cx} cy={cy} r={baseRadius} fill="none" stroke="#151a20" strokeWidth="2" />

      {visibleFeatures.map(({ feature, index }) => {
        const selected = selectedIndex === index;
        const hovered = hoveredIndex === index;
        const lane = featureLane(index, features.length);
        const inner = baseRadius + 12 + lane * 18;
        const outer = inner + 14;
        const color = feature.color ?? FEATURE_FALLBACK;
        return featureToSegments(feature, length).map((segment, segIndex) => {
          const startAngle = ((segment.start - 1) / length) * 360 - 90 + rotation;
          const endAngle = (segment.end / length) * 360 - 90 + rotation;
          const path = describeAnnularArc(cx, cy, inner, outer, startAngle, endAngle);
          const mid = (startAngle + endAngle) / 2;
          const arrow = polar(cx, cy, outer + 3, feature.strand === -1 ? startAngle : endAngle);
          const arrowBack = polar(cx, cy, outer - 7, feature.strand === -1 ? startAngle + 3 : endAngle - 3);
          return (
            <g key={`${index}-${segIndex}`}>
              <path
                d={path}
                fill={color}
                fillOpacity={selected ? 0.95 : hovered ? 0.82 : 0.58}
                stroke={selected || hovered ? "#f4f7fb" : color}
                strokeWidth={selected ? 2.3 : hovered ? 1.8 : 1}
                className="dna-map-feature"
                onClick={(event) => { event.stopPropagation(); onSelectFeature(index); }}
                onMouseEnter={() => onHoverFeature(index)}
                onMouseLeave={() => onHoverFeature(null)}
              >
                <title>{feature.name} · {formatRange(feature)}</title>
              </path>
              {featureLength(feature) > length * 0.012 && (
                <circle cx={arrow.x} cy={arrow.y} r={selected ? 3.5 : 2.3} fill="#0d1014" stroke={color} strokeWidth="1.4" opacity="0.95" />
              )}
              {selected && <line x1={arrowBack.x} y1={arrowBack.y} x2={arrow.x} y2={arrow.y} stroke="#f4f7fb" strokeWidth="1.4" strokeLinecap="round" />}
              {showLabels && (selected || hovered || shouldShowLabel(feature, length, features.length)) && (
                <FeatureLabel
                  feature={feature}
                  color={color}
                  angle={mid}
                  radius={outer + 38 + (index % 2) * 14}
                  cx={cx}
                  cy={cy}
                  selected={selected || hovered}
                  onClick={() => onSelectFeature(index)}
                />
              )}
            </g>
          );
        });
      })}

      {selectedMidAngle != null && (
        <g className="dna-focus-ray">
          <line
            x1={polar(cx, cy, baseRadius - 80, selectedMidAngle).x}
            y1={polar(cx, cy, baseRadius - 80, selectedMidAngle).y}
            x2={polar(cx, cy, baseRadius + 78, selectedMidAngle).x}
            y2={polar(cx, cy, baseRadius + 78, selectedMidAngle).y}
            stroke="#f2d17b"
            strokeWidth="1.5"
            strokeDasharray="5 5"
          />
        </g>
      )}

      <circle cx={cx} cy={cy} r={baseRadius - 90} fill="#10151b" stroke="#26313d" strokeWidth="1" />
      <text x={cx} y={cy - 18} textAnchor="middle" fill="#eef2f6" fontSize="28" fontFamily="Cascadia Code, monospace" fontWeight="700">
        {formatCompactBp(length)}
      </text>
      <text x={cx} y={cy + 2} textAnchor="middle" fill="#8d97a4" fontSize="10" fontFamily="Cascadia Code, monospace" letterSpacing="2">
        {document.topology.toUpperCase()}
      </text>
      <text x={cx} y={cy + 22} textAnchor="middle" fill="#65707d" fontSize="9" fontFamily="Cascadia Code, monospace">
        拖拽旋转 · 点击 feature 联动
      </text>
    </svg>
  );
}

function FeatureLabel({ feature, color, angle, radius, cx, cy, selected, onClick }: {
  feature: DnaFeature;
  color: string;
  angle: number;
  radius: number;
  cx: number;
  cy: number;
  selected: boolean;
  onClick: () => void;
}) {
  const anchor = polar(cx, cy, radius - 20, angle);
  const label = polar(cx, cy, radius, angle);
  const alignRight = Math.cos(degToRad(angle)) < 0;
  const text = trimLabel(feature.name, selected ? 28 : 18);
  return (
    <g className="dna-feature-label" onClick={(event) => { event.stopPropagation(); onClick(); }}>
      <line x1={anchor.x} y1={anchor.y} x2={label.x} y2={label.y} stroke={color} strokeWidth="1" opacity="0.75" />
      <circle cx={anchor.x} cy={anchor.y} r="2" fill={color} />
      <text
        x={label.x + (alignRight ? -5 : 5)}
        y={label.y}
        textAnchor={alignRight ? "end" : "start"}
        dominantBaseline="middle"
        fill={selected ? "#f4f7fb" : "#b9c1ca"}
        fontSize={selected ? 10 : 8.5}
        fontFamily="Segoe UI Variable, Segoe UI, system-ui, sans-serif"
        fontWeight={selected ? 700 : 600}
      >
        {text}
      </text>
    </g>
  );
}

function LinearDetailedMap({ document, features, selectedIndex, hoveredIndex, activeRange, onSelectFeature, onHoverFeature, onFocusPosition }: {
  document: DnaDocument;
  features: IndexedFeature[];
  selectedIndex: number | null;
  hoveredIndex: number | null;
  activeRange: Range | null;
  onSelectFeature: (index: number | null) => void;
  onHoverFeature: (index: number | null) => void;
  onFocusPosition: (position: number) => void;
}) {
  const length = document.sequence.length;
  const width = 760;
  const laneHeight = 24;
  const lanes = assignLinearLanes(features);
  const height = Math.max(260, 92 + lanes.count * laneHeight);
  const padX = 44;
  const axisY = 54;
  const scaleX = (position: number) => padX + ((position - 1) / Math.max(1, length)) * (width - padX * 2);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="dna-plasmid dna-plasmid--linear-detail" role="img" aria-label="线性 DNA 图谱">
      <rect x="0" y="0" width={width} height={height} rx="20" fill="#10151b" />
      <line x1={padX} y1={axisY} x2={width - padX} y2={axisY} stroke="#5a6470" strokeWidth="5" strokeLinecap="round" />
      {makeLinearTicks(length).map((tick) => {
        const x = scaleX(tick.position);
        return (
          <g key={tick.position}>
            <line x1={x} y1={axisY - 14} x2={x} y2={axisY + 14} stroke={tick.major ? "#737d89" : "#323b46"} strokeWidth={tick.major ? 1.4 : 1} />
            {tick.major && <text x={x} y={axisY - 20} textAnchor="middle" fill="#66717e" fontSize="9" fontFamily="Cascadia Code, monospace">{formatCompactBp(tick.position)}</text>}
          </g>
        );
      })}
      {lanes.items.map(({ feature, index, lane }) => {
        const x1 = scaleX(feature.start);
        const x2 = scaleX(feature.end + 1);
        const y = axisY + 28 + lane * laneHeight;
        const selected = selectedIndex === index;
        const hovered = hoveredIndex === index;
        const color = feature.color ?? FEATURE_FALLBACK;
        return (
          <g key={`${feature.name}-${index}-${feature.start}-${feature.end}`} className="dna-linear-feature">
            <rect
              x={x1}
              y={y}
              width={Math.max(3, x2 - x1)}
              height="14"
              rx="7"
              fill={color}
              fillOpacity={selected ? 0.95 : hovered ? 0.78 : 0.52}
              stroke={selected || hovered ? "#f4f7fb" : color}
              strokeWidth={selected ? 2 : 1}
              onClick={() => onSelectFeature(index)}
              onMouseEnter={() => onHoverFeature(index)}
              onMouseLeave={() => onHoverFeature(null)}
            />
            <text x={x1 + 5} y={y - 3} fill={selected ? "#f4f7fb" : "#aeb8c4"} fontSize="9" fontFamily="Segoe UI Variable, Segoe UI, system-ui" fontWeight={selected ? 700 : 500}>{trimLabel(feature.name, 28)}</text>
          </g>
        );
      })}
      {activeRange && (
        <rect x={scaleX(activeRange.start)} y="26" width={Math.max(2, scaleX(activeRange.end + 1) - scaleX(activeRange.start))} height={height - 46} fill="#f2d17b" opacity="0.13" />
      )}
      <rect
        x={padX}
        y={height - 34}
        width={width - padX * 2}
        height="18"
        rx="9"
        fill="#0d1014"
        stroke="#26313d"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
          onFocusPosition(Math.round(1 + ratio * (length - 1)));
        }}
      />
    </svg>
  );
}

function LinearOverview({ document, features, selectedIndex, hoveredIndex, activeRange, searchRanges, onSelectFeature, onHoverFeature, onFocusPosition }: {
  document: DnaDocument;
  features: IndexedFeature[];
  selectedIndex: number | null;
  hoveredIndex: number | null;
  activeRange: Range | null;
  searchRanges: Range[];
  onSelectFeature: (index: number | null) => void;
  onHoverFeature: (index: number | null) => void;
  onFocusPosition: (position: number) => void;
}) {
  const length = document.sequence.length;
  const width = 760;
  const height = 86;
  const padX = 32;
  const y = 42;
  const scaleX = (position: number) => padX + ((position - 1) / Math.max(1, length)) * (width - padX * 2);
  const shownFeatures = features.slice(0, 260);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="dna-linear-overview" role="img" aria-label="线性总览轨道">
      <rect
        x="0"
        y="0"
        width={width}
        height={height}
        rx="14"
        fill="#0d1014"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const localX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width;
          const ratio = clamp((localX - padX) / Math.max(1, width - padX * 2), 0, 1);
          onFocusPosition(Math.round(1 + ratio * (length - 1)));
        }}
      />
      <text x="18" y="19" fill="#5f6a76" fontSize="9" fontFamily="Cascadia Code, monospace" fontWeight="700">LINEAR OVERVIEW</text>
      <line x1={padX} y1={y} x2={width - padX} y2={y} stroke="#44505d" strokeWidth="3" strokeLinecap="round" />
      {shownFeatures.map(({ feature, index }) => {
        const selected = selectedIndex === index;
        const hovered = hoveredIndex === index;
        const x1 = scaleX(feature.start);
        const x2 = scaleX(feature.end + 1);
        const color = feature.color ?? FEATURE_FALLBACK;
        return (
          <rect
            key={`${feature.name}-${index}-${feature.start}-${feature.end}`}
            x={x1}
            y={selected || hovered ? 28 : 33}
            width={Math.max(2, x2 - x1)}
            height={selected || hovered ? 18 : 10}
            rx="4"
            fill={color}
            fillOpacity={selected ? 0.98 : hovered ? 0.8 : 0.54}
            stroke={selected || hovered ? "#f4f7fb" : "none"}
            onClick={() => onSelectFeature(index)}
            onMouseEnter={() => onHoverFeature(index)}
            onMouseLeave={() => onHoverFeature(null)}
          />
        );
      })}
      {searchRanges.slice(0, 150).map((range, index) => (
        <rect key={`search-${index}`} x={scaleX(range.start)} y="58" width={Math.max(2, scaleX(range.end + 1) - scaleX(range.start))} height="8" rx="2" fill="#f2d17b" opacity="0.65" />
      ))}
      {activeRange && (
        <line x1={scaleX(activeRange.start)} y1="18" x2={scaleX(activeRange.start)} y2="76" stroke="#f2d17b" strokeWidth="2" strokeDasharray="4 4" />
      )}
      <text x={padX} y="78" fill="#5f6a76" fontSize="8" fontFamily="Cascadia Code, monospace">1</text>
      <text x={width - padX} y="78" textAnchor="end" fill="#5f6a76" fontSize="8" fontFamily="Cascadia Code, monospace">{length.toLocaleString("en-US")}</text>
    </svg>
  );
}

function FeatureTrack({ features, rowStart, rowEnd, lineLength, selectedIndex, hoveredIndex, onSelectFeature, onHoverFeature }: {
  features: IndexedFeature[];
  rowStart: number;
  rowEnd: number;
  lineLength: number;
  selectedIndex: number | null;
  hoveredIndex: number | null;
  onSelectFeature: (index: number | null) => void;
  onHoverFeature: (index: number | null) => void;
}) {
  const rowFeatures = features.filter(({ feature }) => overlaps(feature, rowStart, rowEnd)).slice(0, 8);
  if (rowFeatures.length === 0) return <div className="dna-feature-track" />;
  return (
    <div className="dna-feature-track">
      {rowFeatures.map(({ feature, index }, lane) => {
        const start = clamp(feature.start, rowStart, rowEnd);
        const end = clamp(feature.end, rowStart, rowEnd);
        const left = ((start - rowStart) / Math.max(1, lineLength)) * 100;
        const width = ((end - start + 1) / Math.max(1, lineLength)) * 100;
        const selected = selectedIndex === index;
        const hovered = hoveredIndex === index;
        const style: CSSProperties = {
          left: `${left}%`,
          width: `${Math.max(0.8, width)}%`,
          top: `${lane * 4}px`,
          background: feature.color ?? FEATURE_FALLBACK,
        };
        return (
          <button
            key={`${feature.name}-${index}`}
            type="button"
            className={`dna-feature-track-bar${selected ? " is-selected" : ""}${hovered ? " is-hovered" : ""}`}
            style={style}
            title={`${feature.name} · ${formatRange(feature)}`}
            onClick={() => onSelectFeature(index)}
            onMouseEnter={() => onHoverFeature(index)}
            onMouseLeave={() => onHoverFeature(null)}
          />
        );
      })}
    </div>
  );
}

function chunk(value: string, size: number): string[] {
  const out: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    out.push(value.slice(index, index + size));
  }
  return out;
}

function renderBases(
  line: string,
  features: IndexedFeature[],
  rowStart: number,
  selectedIndex: number | null,
  hoveredIndex: number | null,
  activeRange: Range | null,
  searchRanges: Range[],
) {
  const rowEnd = rowStart + line.length - 1;
  const activeFeatures = features.filter(({ feature }) => feature.end >= rowStart && feature.start <= rowEnd);
  return Array.from(line).map((char, index) => {
    const position = rowStart + index;
    const color = NUCLEOTIDE_COLORS[char] ?? "#8b919a";
    const spanStyle: CSSProperties = { color };
    const classes = ["dna-base"];
    const matched = activeFeatures.find(({ feature }) => position >= feature.start && position <= feature.end);
    if (matched) {
      spanStyle.borderBottom = `2px solid ${matched.feature.color ?? FEATURE_FALLBACK}`;
      spanStyle.paddingBottom = "1px";
      if (selectedIndex === matched.index) classes.push("is-feature-selected");
      if (hoveredIndex === matched.index) classes.push("is-feature-hovered");
    }
    if (activeRange && positionInRange(position, activeRange)) classes.push("is-active-range");
    if (searchRanges.some((range) => positionInRange(position, range))) classes.push("is-search-hit");
    return <span key={index} className={classes.join(" ")} style={spanStyle}>{char}</span>;
  });
}

function buildSearchResults(document: DnaDocument, rawQuery: string): SearchResult[] {
  const query = rawQuery.trim();
  if (!query) return [];
  const results: SearchResult[] = [];
  const compact = query.replace(/\s+/g, "");
  const nucleotideQuery = compact.toUpperCase().replace(/U/g, "T");
  if (/^[ACGTNRYKMSWBDHV]+$/i.test(compact) && nucleotideQuery.length >= 2) {
    const haystack = document.topology === "circular"
      ? document.sequence + document.sequence.slice(0, nucleotideQuery.length - 1)
      : document.sequence;
    let cursor = 0;
    while (results.length < SEARCH_LIMIT) {
      const found = haystack.indexOf(nucleotideQuery, cursor);
      if (found < 0 || found >= document.sequence.length) break;
      const start = found + 1;
      const end = Math.min(document.sequence.length, found + nucleotideQuery.length);
      results.push({ kind: "sequence", label: `${nucleotideQuery} @ ${start.toLocaleString("en-US")} bp`, start, end });
      cursor = found + 1;
    }
  }
  const lower = query.toLowerCase();
  document.features.forEach((feature, featureIndex) => {
    const text = `${feature.name} ${feature.type ?? ""}`.toLowerCase();
    if (text.includes(lower)) {
      results.push({
        kind: "feature",
        label: `${feature.name} · ${formatRange(feature)}`,
        start: feature.start,
        end: feature.end,
        featureIndex,
      });
    }
  });
  return results.slice(0, SEARCH_LIMIT);
}

// For a circular plasmid rendered in the linear view, any feature whose end
// lies before its start crosses the origin and would visually disappear past
// the right edge of the axis. Split it into two adjacent segments so the
// annotation stays visible (e.g. a feature 4,500→500 on a 5,000 bp plasmid
// becomes two lanes: 4,500→5,000 and 1→500). Both pieces keep the original
// feature index so click/hover selection still maps back to the same entry.
function expandCircularFeatures(features: IndexedFeature[], sequenceLength: number): IndexedFeature[] {
  const expanded: IndexedFeature[] = [];
  for (const { feature, index } of features) {
    if (feature.end >= feature.start || feature.start > sequenceLength) {
      expanded.push({ feature, index });
      continue;
    }
    expanded.push({ feature: { ...feature, end: sequenceLength }, index });
    expanded.push({ feature: { ...feature, start: 1 }, index });
  }
  return expanded;
}

function featureToSegments(feature: DnaFeature, sequenceLength: number): Range[] {
  if (feature.end >= feature.start) return [{ start: feature.start, end: feature.end }];
  return [{ start: feature.start, end: sequenceLength }, { start: 1, end: feature.end }];
}

function featureLength(feature: DnaFeature): number {
  return Math.max(1, Math.abs(feature.end - feature.start) + 1);
}

function overlaps(feature: DnaFeature, start: number, end: number): boolean {
  return feature.end >= start && feature.start <= end;
}

function positionInRange(position: number, range: Range): boolean {
  if (range.end >= range.start) return position >= range.start && position <= range.end;
  return position >= range.start || position <= range.end;
}

function formatRange(feature: DnaFeature): string {
  return `${feature.start.toLocaleString("en-US")}–${feature.end.toLocaleString("en-US")}`;
}

function sliceFeatureSequence(sequence: string, feature: DnaFeature): string {
  if (feature.end >= feature.start) return sequence.slice(feature.start - 1, feature.end);
  return sequence.slice(feature.start - 1) + sequence.slice(0, feature.end);
}

function reverseComplement(sequence: string): string {
  const complement: Record<string, string> = { A: "T", T: "A", U: "A", G: "C", C: "G", N: "N" };
  return Array.from(sequence.toUpperCase()).reverse().map((char) => complement[char] ?? "N").join("");
}

function gcPercent(sequence: string): number {
  if (sequence.length === 0) return 0;
  let gc = 0;
  for (const char of sequence) if (char === "G" || char === "C") gc += 1;
  return (gc / sequence.length) * 100;
}

function toFasta(name: string, sequence: string): string {
  return `>${name.replace(/\s+/g, "_")}\n${chunk(sequence, 80).join("\n")}\n`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function degToRad(angle: number): number {
  return angle * Math.PI / 180;
}

function polar(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  const rad = degToRad(angle);
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}

function describeAnnularArc(cx: number, cy: number, innerRadius: number, outerRadius: number, startAngle: number, endAngle: number): string {
  const safeEnd = endAngle <= startAngle ? endAngle + 0.01 : endAngle;
  const largeArc = safeEnd - startAngle > 180 ? 1 : 0;
  const outerStart = polar(cx, cy, outerRadius, startAngle);
  const outerEnd = polar(cx, cy, outerRadius, safeEnd);
  const innerEnd = polar(cx, cy, innerRadius, safeEnd);
  const innerStart = polar(cx, cy, innerRadius, startAngle);
  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerRadius.toFixed(2)} ${outerRadius.toFixed(2)} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A ${innerRadius.toFixed(2)} ${innerRadius.toFixed(2)} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function rangeMidAngle(range: Range, sequenceLength: number, rotation: number): number {
  const start = ((range.start - 1) / sequenceLength) * 360 - 90 + rotation;
  const end = (range.end / sequenceLength) * 360 - 90 + rotation;
  return (start + end) / 2;
}

function featureLane(index: number, total: number): number {
  if (total <= 32) return index % 3;
  return index % 4;
}

function shouldShowLabel(feature: DnaFeature, sequenceLength: number, totalFeatures: number): boolean {
  if (totalFeatures <= 18) return true;
  return featureLength(feature) / sequenceLength > 0.035;
}

function trimLabel(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
}

function makeGcBins(sequence: string, bins: number): Array<{ angle: number; value: number }> {
  if (sequence.length === 0) return [];
  const out: Array<{ angle: number; value: number }> = [];
  const binSize = Math.max(1, Math.ceil(sequence.length / bins));
  for (let index = 0; index < bins; index += 1) {
    const start = index * binSize;
    const slice = sequence.slice(start, Math.min(sequence.length, start + binSize));
    if (!slice) break;
    out.push({ angle: ((start + slice.length / 2) / sequence.length) * 360 - 90, value: gcPercent(slice) / 100 });
  }
  return out;
}

function makeTicks(sequenceLength: number, rotation: number): Array<{ position: number; angle: number; major: boolean }> {
  const tickCount = sequenceLength <= 6000 ? 12 : 16;
  const out: Array<{ position: number; angle: number; major: boolean }> = [];
  for (let index = 0; index < tickCount; index += 1) {
    const position = Math.max(1, Math.round((sequenceLength / tickCount) * index) + 1);
    out.push({
      position,
      angle: ((position - 1) / sequenceLength) * 360 - 90 + rotation,
      major: index % 2 === 0,
    });
  }
  return out;
}

function makeLinearTicks(sequenceLength: number): Array<{ position: number; major: boolean }> {
  const count = sequenceLength <= 6000 ? 10 : 12;
  const out: Array<{ position: number; major: boolean }> = [];
  for (let index = 0; index <= count; index += 1) {
    out.push({ position: Math.max(1, Math.round((sequenceLength / count) * index)), major: index % 2 === 0 });
  }
  return out;
}

function formatCompactBp(position: number): string {
  if (position >= 1_000_000) return `${(position / 1_000_000).toFixed(1)} Mb`;
  if (position >= 1000) return `${(position / 1000).toFixed(position >= 10_000 ? 0 : 1)} kb`;
  return `${position} bp`;
}

function assignLinearLanes(features: IndexedFeature[]): { items: Array<IndexedFeature & { lane: number }>; count: number } {
  const laneEnds: number[] = [];
  const items = features.map((item) => {
    let lane = laneEnds.findIndex((end) => item.feature.start > end);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.feature.end);
    } else {
      laneEnds[lane] = item.feature.end;
    }
    return { ...item, lane };
  });
  return { items, count: Math.max(1, laneEnds.length) };
}
