// Convert between legacy .doc and modern .docx using Microsoft Word COM
// automation. The server hands us base64-encoded input via stdin and we
// return base64-encoded output via stdout. We stage files in os.tmpdir()
// because Word COM opens files by absolute path.
//
//   stdin  : { "mode": "doc-to-docx" | "docx-to-doc",
//              "inputBase64": "<base64>" }
//   stdout : { "outputBase64": "<base64>" }
//   exit 0 : success
//   exit 1 : usage / IO error
//   exit 2 : Word automation error
//   exit 3 : timeout

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FORMATS = {
  "doc-to-docx": { inputExt: ".doc", outputExt: ".docx", formatCode: 16 },
  "docx-to-doc": { inputExt: ".docx", outputExt: ".doc", formatCode: 0 },
};

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    process.stderr.write("invalid json payload: " + err.message + "\n");
    process.exit(1);
  }

  const mode = payload?.mode;
  const fmt = FORMATS[mode];
  if (!fmt) {
    process.stderr.write(`unknown mode: ${mode}\n`);
    process.exit(1);
  }
  if (typeof payload.inputBase64 !== "string" || payload.inputBase64.length === 0) {
    process.stderr.write("missing inputBase64\n");
    process.exit(1);
  }

  const inputBytes = Buffer.from(payload.inputBase64, "base64");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-word-"));
  const inputPath = path.join(tmpRoot, "input" + fmt.inputExt);
  const outputPath = path.join(tmpRoot, "output" + fmt.outputExt);
  fs.writeFileSync(inputPath, inputBytes);

  const scriptDir = path.resolve(__dirname);
  const vbsPath = path.join(scriptDir, "word-format-convert.vbs");

  try {
    execFileSync("cscript.exe", [
      "//NoLogo",
      "//B",
      vbsPath,
      inputPath,
      outputPath,
      String(fmt.formatCode),
    ], { encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const stdout = err.stdout?.toString() ?? "";
    const stderr = err.stderr?.toString() ?? "";
    process.stderr.write(`conversion failed (exit=${err.status})\n${stdout}${stderr}\n`);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    if (err.signal === "SIGTERM" || err.code === "ETIMEDOUT") process.exit(3);
    process.exit(2);
  }

  if (!fs.existsSync(outputPath)) {
    process.stderr.write("conversion reported OK but output missing\n");
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    process.exit(2);
  }

  const outputBytes = fs.readFileSync(outputPath);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

  const response = { outputBase64: outputBytes.toString("base64") };
  process.stdout.write(JSON.stringify(response));
}

main().catch((err) => {
  process.stderr.write("unexpected: " + (err?.stack ?? err) + "\n");
  process.exit(1);
});