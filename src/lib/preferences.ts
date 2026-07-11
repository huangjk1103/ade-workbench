// Shared user preferences. Kept in localStorage so the value survives reloads
// and is readable before the SettingsPanel mounts - main.tsx applies the
// background style during bootstrap to avoid a flash of the default theme.
//
// The SettingsPanel owns the live `prefs` state and persists every change via
// `savePreferences`; `applyBackgroundStyle` is the bridge that mirrors a
// background-style change onto <html> so CSS can layer decorative gradients
// without React re-rendering the shell.

export type BackgroundStyle = "solid" | "aurora" | "mesh" | "grid" | "topography" | "night";

export const BACKGROUND_STYLES: ReadonlyArray<{ value: BackgroundStyle; label: string; hint: string }> = [
  { value: "solid", label: "纯色", hint: "默认深色平面" },
  { value: "aurora", label: "极光", hint: "青蓝紫柔光色带" },
  { value: "mesh", label: "渐变网格", hint: "多色光晕渐变" },
  { value: "grid", label: "细网格", hint: "技术感细线网格" },
  { value: "topography", label: "等高线", hint: "同心环地形纹" },
  { value: "night", label: "星空", hint: "夜空星点微光" },
];

export interface Preferences {
  theme: "dark" | "light" | "system";
  density: "compact" | "standard" | "comfortable";
  autoSaveMs: number;
  autoSnapshotOnSend: boolean;
  sidebarExpandedByDefault: boolean;
  journalKeepRecent: number;
  backgroundStyle: BackgroundStyle;
}

export const PREFERENCES_STORAGE_KEY = "ade.preferences.v1";

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "dark",
  density: "standard",
  autoSaveMs: 1500,
  autoSnapshotOnSend: true,
  sidebarExpandedByDefault: false,
  journalKeepRecent: 2000,
  backgroundStyle: "solid",
};

export function loadPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return { ...DEFAULT_PREFERENCES, ...parsed };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(prefs: Preferences) {
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch { /* private mode / quota exceeded - fall back to in-memory only */ }
}

// Reflect the background style on <html> as `data-background`. CSS rules of
// the form `:root[data-background="<style>"] .ade-shell` layer the decorative
// gradients; the attribute is always set so the "solid" default is explicit.
export function applyBackgroundStyle(style: BackgroundStyle) {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-background", style);
  }
}
