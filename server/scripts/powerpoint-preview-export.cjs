// Ask installed Microsoft PowerPoint to create a high-fidelity, flattened
// PPTX preview. The original presentation is read-only and never modified.
// stdin: { inputPath, outputPath }
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const payload = JSON.parse(await readStdin());
  if (!payload?.inputPath || !payload?.outputPath) throw new Error("inputPath and outputPath are required");
  fs.mkdirSync(path.dirname(payload.outputPath), { recursive: true });
  const script = path.join(__dirname, "powerpoint-preview-export.vbs");
  try {
    execFileSync("cscript.exe", [
      "//NoLogo", "//B", script, payload.inputPath, payload.outputPath,
    ], { timeout: 180000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stdout = error.stdout?.toString() ?? "";
    const stderr = error.stderr?.toString() ?? "";
    throw new Error(`PowerPoint preview export failed (exit=${error.status})\n${stdout}${stderr}`);
  }
  if (!fs.existsSync(payload.outputPath) || fs.statSync(payload.outputPath).size < 1000) {
    throw new Error("PowerPoint preview export did not create a valid PPTX");
  }
  process.stdout.write(JSON.stringify({ outputPath: payload.outputPath }));
}

main().catch((error) => {
  process.stderr.write((error?.stack ?? String(error)) + "\n");
  process.exit(1);
});
