import { type RefObject, useCallback, useEffect, useState } from "react";

// Persisted sidebar widths. Kept as a separate key from `Preferences` so the
// panel/layout state survives a settings reset (and so it never leaks into
// the saved preferences JSON).
const STORAGE_KEY = "ade.layout.sidebarWidths.v1";

interface PersistedWidths {
  left?: number;
  right?: number;
}

function loadPersisted(): PersistedWidths {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedWidths;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function persistWidths(left: number | undefined, right: number | undefined) {
  try {
    const current = loadPersisted();
    const next: PersistedWidths = { ...current };
    if (left !== undefined) next.left = Math.round(left);
    if (right !== undefined) next.right = Math.round(right);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { /* private mode / quota exceeded - fall back to in-memory only */ }
}

export interface UseResizableSidebarOptions {
  // Default width applied when nothing is persisted yet. The hook falls
  // back to this whenever the parent container is too small to honour the
  // requested minimum.
  defaultWidth: number;
  // Inclusive lower bound. We won't let the user drag below this.
  minWidth: number;
  // Inclusive upper bound. Capped at the parent's measured width minus a
  // small reserved strip for the centre column.
  maxWidth: number;
  // Which side of the element the handle sits on. Controls the sign of the
  // drag delta — moving the mouse right grows a right-edge handle and
  // shrinks a left-edge handle.
  side: "left" | "right";
  // Persist on change so reloads restore the user's preferred layout.
  persistKey: "left" | "right";
  // Ref to the grid container. We measure this element to compute the
  // upper bound dynamically (a 600px inspector can't fit in a 700px
  // window). Optional — without it we just use the static `maxWidth`.
  containerRef?: RefObject<HTMLElement | null>;
  // Minimum width reserved for the centre column. Defaults to 220px.
  // We won't grow the sidebar past `containerWidth - reserved`.
  reservedCenter?: number;
}

export interface ResizableSidebarState {
  width: number;
  // Whether the user is currently mid-drag. Consumers can toggle a body
  // class to disable text selection while dragging.
  isDragging: boolean;
  // Spread on the resize handle element. The handle is intentionally
  // pointer-only — clicking inside the bar shouldn't drag, only the
  // dedicated handle.
  handleProps: {
    onMouseDown: (event: React.MouseEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    onDoubleClick: (event: React.MouseEvent) => void;
    role: string;
    "aria-orientation": "vertical";
    "aria-valuenow": number;
    "aria-valuemin": number;
    "aria-valuemax": number;
    title: string;
    tabIndex: number;
  };
  // Apply directly to the grid container. `cssVar` is the name of the
  // CSS custom property (without the leading `--`) that the layout uses
  // for the column width.
  style: React.CSSProperties;
  // Programmatic reset to the default width. Wired to double-click on
  // the handle so users have an obvious "snap back" affordance.
  reset: () => void;
}

export function useResizableSidebar(options: UseResizableSidebarOptions): ResizableSidebarState {
  const { defaultWidth, minWidth, maxWidth, side, persistKey, containerRef, reservedCenter = 220 } = options;
  const persisted = loadPersisted()[persistKey];
  const initialWidth = clamp(persisted ?? defaultWidth, minWidth, maxWidth);
  const [width, setWidth] = useState<number>(initialWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number>(0);

  // Track the grid container's width so we can dynamically tighten the
  // upper bound when the window shrinks. Without this, a user-resized
  // 600px inspector would overflow a 700px-wide window.
  useEffect(() => {
    const element = containerRef?.current;
    if (!element) return;
    setContainerWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef]);

  // If the container shrinks past the current width, gently clamp back
  // toward the default rather than overflowing the layout.
  useEffect(() => {
    if (containerWidth === 0) return;
    const hardMax = Math.max(minWidth, containerWidth - reservedCenter);
    const upper = Math.min(maxWidth, hardMax);
    if (width > upper) setWidth(clamp(width, minWidth, upper));
  }, [containerWidth, maxWidth, minWidth, reservedCenter, width]);

  // Persist whenever the width changes. We debounce via a microtask
  // coalescing effect so a rapid drag doesn't hammer localStorage.
  useEffect(() => {
    const id = window.setTimeout(() => persistWidths(
      persistKey === "left" ? width : undefined,
      persistKey === "right" ? width : undefined,
    ), 120);
    return () => window.clearTimeout(id);
  }, [width, persistKey]);

  // Drag lifecycle. We attach the mousemove/mouseup listeners to `window`
  // instead of the handle so the user can drag past the handle's bounds
  // without losing the gesture, and so a single mousedown anywhere on
  // the page after release can't re-trigger a drag.
  useEffect(() => {
    if (!isDragging) return;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const handleMove = (event: MouseEvent) => {
      const container = containerRef?.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      // For a right-side handle (inspector), width grows when the mouse
      // moves left, so we anchor on `rect.right - clientX`. For a left-side
      // handle (sidebar), width grows when the mouse moves right, so we
      // anchor on `clientX - rect.left`.
      const proposed = side === "left"
        ? event.clientX - rect.left
        : rect.right - event.clientX;
      const hardMax = Math.max(minWidth, rect.width - reservedCenter);
      const upper = Math.min(maxWidth, hardMax);
      setWidth(clamp(proposed, minWidth, upper));
    };
    const handleUp = () => setIsDragging(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isDragging, minWidth, maxWidth, side, containerRef, reservedCenter]);

  const startDrag = useCallback((event: React.MouseEvent | React.PointerEvent) => {
    // Only the primary mouse button (or a touch/pen primary contact)
    // should start a drag. Right-click on the handle should still let
    // the browser show its context menu if we ever wire one up.
    if ("button" in event && event.button !== 0) return;
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    // Keyboard accessibility: ←/→ adjusts by 8px, PgUp/PgDn by 40px,
    // Home/End snap to bounds. This is the same set of keys a native
    // <input type="range"> would respond to, so muscle memory transfers.
    const step = event.shiftKey ? 40 : 8;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = side === "left" ? 1 : -1;
      const delta = (event.key === "ArrowLeft" ? -1 : 1) * direction * step;
      setWidth((current) => clamp(current + delta, minWidth, maxWidth));
    } else if (event.key === "PageUp") {
      event.preventDefault();
      setWidth((current) => clamp(side === "left" ? current + 40 : current - 40, minWidth, maxWidth));
    } else if (event.key === "PageDown") {
      event.preventDefault();
      setWidth((current) => clamp(side === "left" ? current - 40 : current + 40, minWidth, maxWidth));
    } else if (event.key === "Home") {
      event.preventDefault();
      setWidth(side === "left" ? minWidth : maxWidth);
    } else if (event.key === "End") {
      event.preventDefault();
      setWidth(side === "left" ? maxWidth : minWidth);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setWidth(defaultWidth);
    }
  }, [defaultWidth, maxWidth, minWidth, side]);

  const reset = useCallback(() => {
    setWidth(defaultWidth);
  }, [defaultWidth]);

  const cssVar = side === "left" ? "--sidebar-width" : "--inspector-width";

  return {
    width,
    isDragging,
    handleProps: {
      onMouseDown: startDrag,
      onPointerDown: startDrag,
      onKeyDown,
      onDoubleClick: (event) => { event.preventDefault(); reset(); },
      role: "separator",
      "aria-orientation": "vertical",
      "aria-valuenow": Math.round(width),
      "aria-valuemin": minWidth,
      "aria-valuemax": maxWidth,
      title: side === "left"
        ? "拖拽调整左侧边栏宽度（双击复位）"
        : "拖拽调整右侧检查器宽度（双击复位）",
      tabIndex: 0,
    },
    style: { [cssVar]: `${width}px` } as React.CSSProperties,
    reset,
  };
}

// Clamp a number into the inclusive [min, max] range. Extracted so the
// various code paths (initial load, drag, keyboard) all share one
// implementation.
function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}