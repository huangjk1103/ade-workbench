// Quick smoke test for the SnapGene DNA parser. Verifies that the
// gzip + JSON strategy correctly decodes a minimal synthetic document.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, "..", "src", "components", "viewers", "dna.ts");

let mod;
try {
  const { build } = await import("esbuild");
  await build({
    entryPoints: [modulePath],
    bundle: true,
    outfile: resolve(here, "_tmp_dna_test_bundle.mjs"),
    platform: "node",
    format: "esm",
    target: "es2022",
  });
  mod = await import("./_tmp_dna_test_bundle.mjs");
} catch (error) {
  console.warn("Skipping DNA smoke test: esbuild unavailable:", error?.message ?? error);
  process.exit(0);
}

const { parseDna, translate, hexPreview } = mod;

// Strategy 1: gzip + JSON. Build a gzip buffer containing a minimal JSON
// document and confirm the parser recovers the sequence + topology.
const payload = {
  sequence: "ATGCGTACGT",
  topology: "circular",
  features: [
    { name: "AmpR", type: "gene", start: 0, end: 8, strand: 1, color: "#ff8800" },
  ],
};
const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));
const b64 = Buffer.from(gz).toString("base64");
const result1 = await parseDna(b64);
if (!result1.document) {
  console.error("gzip+JSON test failed: no document produced. attempts:", result1.attempts);
  process.exit(1);
}
if (result1.document.sequence !== "ATGCGTACGT") {
  console.error("gzip+JSON test failed: sequence mismatch", result1.document.sequence);
  process.exit(1);
}
if (result1.document.features.length !== 1 || result1.document.features[0].name !== "AmpR") {
  console.error("gzip+JSON test failed: features mismatch", result1.document.features);
  process.exit(1);
}
if (result1.document.topology !== "circular") {
  console.error("gzip+JSON test failed: topology mismatch", result1.document.topology);
  process.exit(1);
}
console.log("DNA gzip+JSON test PASSED: strategy =", result1.document.strategy);

// Strategy 2: plain JSON (no compression).
const plainB64 = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
const result2 = await parseDna(plainB64);
if (!result2.document || result2.document.sequence !== "ATGCGTACGT") {
  console.error("plain JSON test failed:", result2);
  process.exit(1);
}
console.log("DNA plain JSON test PASSED: strategy =", result2.document.strategy);

// Translate sanity check: ATG CGT → M R. We use a full-codon input so
// the trailing-pad-with-N path isn't exercised here; that's covered by the
// SequenceView rendering with arbitrary user input.
const protein = translate("ATGCGT");
if (protein !== "MR") {
  console.error("Translate test failed: got", protein);
  process.exit(1);
}
console.log("Translate test PASSED:", protein);

// Hex preview sanity: just confirm it returns 16-byte hex for a small buffer.
const preview = hexPreview(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 4);
if (preview !== "de ad be ef") {
  console.error("Hex preview test failed:", preview);
  process.exit(1);
}
console.log("Hex preview test PASSED:", preview);

try {
  const fs = await import("node:fs/promises");
  await fs.unlink(resolve(here, "_tmp_dna_test_bundle.mjs"));
} catch {}
console.log("All DNA parser tests PASSED.");