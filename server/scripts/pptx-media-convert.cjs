// Replace browser-incompatible EMF/WMF media inside a PPTX package with PNG.
// stdin/stdout are base64 so the Rust server never modifies the source file.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main() {
  const inputBase64 = await readStdin();
  if (!inputBase64) throw new Error("missing PPTX base64 payload");
  const zip = await JSZip.loadAsync(Buffer.from(inputBase64, "base64"));
  const media = Object.values(zip.files).filter((entry) => !entry.dir && /\.(?:emf|wmf)$/i.test(entry.name));
  if (!media.length) {
    process.stdout.write(inputBase64);
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pptx-media-"));
  const rasterizer = path.join(__dirname, "rasterize-office-image.ps1");
  const replacements = [];
  try {
    for (let index = 0; index < media.length; index += 1) {
      const entry = media[index];
      const extension = path.extname(entry.name);
      const inputPath = path.join(tmpRoot, `input-${index}${extension}`);
      const outputPath = path.join(tmpRoot, `output-${index}.png`);
      fs.writeFileSync(inputPath, await entry.async("nodebuffer"));
      execFileSync("powershell.exe", [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", rasterizer, inputPath, outputPath,
      ], { timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
      const png = fs.readFileSync(outputPath);
      const replacementName = entry.name.slice(0, -extension.length) + ".png";
      zip.file(replacementName, png);
      zip.remove(entry.name);
      replacements.push({ from: path.basename(entry.name), to: path.basename(replacementName) });
    }

    const relationshipFiles = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.endsWith(".rels"));
    for (const relationship of relationshipFiles) {
      let xml = await relationship.async("string");
      let changed = false;
      for (const { from, to } of replacements) {
        const next = xml.replace(new RegExp(escapeRegExp(from), "gi"), to);
        changed ||= next !== xml;
        xml = next;
      }
      if (changed) zip.file(relationship.name, xml);
    }

    const contentTypes = zip.file("[Content_Types].xml");
    if (contentTypes) {
      let xml = await contentTypes.async("string");
      if (!/Extension=["']png["']/i.test(xml)) {
        xml = xml.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>');
        zip.file("[Content_Types].xml", xml);
      }
    }

    const output = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    process.stdout.write(output.toString("base64"));
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
}

main().catch((error) => {
  process.stderr.write((error?.stack ?? String(error)) + "\n");
  process.exit(1);
});
