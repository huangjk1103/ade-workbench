const { randomUUID } = require("node:crypto");
const { readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const input = readFileSync(0, "utf8").trim();
if (!input) throw new Error("PowerPoint 编辑请求为空");

const request = JSON.parse(input);
if (!request.inputPath || !request.mode) throw new Error("PowerPoint 编辑请求缺少 inputPath 或 mode");

const requestPath = path.join(tmpdir(), `ade-powerpoint-editor-${randomUUID()}.json`);
const scriptPath = path.join(__dirname, "powerpoint-editor.ps1");

try {
  writeFileSync(requestPath, JSON.stringify(request), "utf8");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-RequestPath", requestPath],
    { encoding: "utf8", timeout: 180_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "PowerPoint 编辑脚本执行失败").trim());
  }
  process.stdout.write((result.stdout || "{}").trim());
} finally {
  try { unlinkSync(requestPath); } catch { /* best effort */ }
}
