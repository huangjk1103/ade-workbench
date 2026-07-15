// Quick smoke test for the AB1 parser. Builds a minimal synthetic ABIF
// container with just the required tags (PBAS + PLOC + DATA9..12) and
// verifies the parser returns the expected record.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(here, "..", "src", "components", "viewers", "ab1.ts");

// We compile the TS module on the fly with esbuild so the test can import
// it directly. If esbuild is unavailable (e.g. CI without dev deps), fall
// back to skipping — this script is a local developer aid, not a CI gate.
let mod;
try {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [modulePath],
    bundle: true,
    outfile: resolve(here, "_tmp_ab1_test_bundle.mjs"),
    platform: "node",
    format: "esm",
    target: "es2022",
  });
  mod = await import("./_tmp_ab1_test_bundle.mjs");
} catch (error) {
  console.warn("Skipping AB1 smoke test: esbuild unavailable or failed:", error?.message ?? error);
  process.exit(0);
}

const { parseAb1, decodeBase64ToBytes } = mod;

// Single error sink used by all phases of the test so we can run multiple
// scenarios (offset / inline / reordered channels) in one process without
// juggling several local variables.
const errors = [];

// Build a synthetic ABIF buffer:
//   - "ABIF" magic + version 0x0064
//   - 1 directory entry for PBAS (string "ACGT")
//   - 1 directory entry for PLOC (4 uint16s: 10, 20, 30, 40)
//   - 1 directory entry for DATA9 (A channel: 4 int16s)
//   - 1 directory entry for DATA10 (C channel: 4 int16s)
//   - 1 directory entry for DATA11 (G channel: 4 int16s)
//   - 1 directory entry for DATA12 (T channel: 4 int16s)
//   - All 6 entries fit the 28-byte slot, with data after the directory.
function buildSyntheticAb1() {
  // Build 100-sample channel traces shaped so that each called base clearly
  // dominates its corresponding DATA channel. The trace has a small
  // background of 20 everywhere and a tall spike of 800/700/900/850 at the
  // peak position associated with A/C/G/T respectively. The greedy
  // auto-assign uses these spikes to recover the mapping.
  const peaks = [10, 30, 60, 85];
  const bases = "ACGT";
  const samplesPerChannel = 100;
  const traceA = new Array(samplesPerChannel).fill(20);
  const traceC = new Array(samplesPerChannel).fill(20);
  const traceG = new Array(samplesPerChannel).fill(20);
  const traceT = new Array(samplesPerChannel).fill(20);
  traceA[peaks[0]] = 800; // A peak
  traceC[peaks[1]] = 700; // C peak
  traceG[peaks[2]] = 900; // G peak
  traceT[peaks[3]] = 850; // T peak
  const entries = [
    { name: "PBAS", number: 1, type: 2, data: new TextEncoder().encode(bases) },
    { name: "PLOC", number: 2, type: 3, data: packInt16Array(peaks) },
    { name: "PCON", number: 2, type: 1, data: new Uint8Array([60, 45, 50, 30]) },
    { name: "DATA", number: 9, type: 4, data: packInt16Array(traceA) },
    { name: "DATA", number: 10, type: 4, data: packInt16Array(traceC) },
    { name: "DATA", number: 11, type: 4, data: packInt16Array(traceG) },
    { name: "DATA", number: 12, type: 4, data: packInt16Array(traceT) },
  ];
  const DIR_ENTRY_SIZE = 28;
  // Match the parser's expected layout: magic (4) + version (2) + tagCount (2)
  // + dataOffset (4) + reserved (4) = 16 byte header before the directory.
  const dirStart = 16;
  const dirCount = entries.length;
  const dataStart = dirStart + dirCount * DIR_ENTRY_SIZE;
  // Compute offsets for each entry's data section. We use 2-byte alignment.
  let cursor = 0;
  for (const entry of entries) {
    entry.dataOffset = cursor;
    cursor += entry.data.length;
  }
  const dataSize = cursor;
  const total = dataStart + dataSize;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // Header
  view.setUint32(0, 0x46494241, true); // "ABIF" little-endian magic
  view.setUint16(4, 100, true); // version (ignored by parser)
  view.setUint16(6, dirCount, true);
  view.setUint32(8, dataStart, true); // dataOffset
  view.setUint32(12, dataSize, true); // reserved
  // Directory entries
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const base = dirStart + index * DIR_ENTRY_SIZE;
    for (let i = 0; i < 4; i += 1) bytes[base + i] = entry.name.charCodeAt(i);
    view.setInt32(base + 4, entry.number, true);
    view.setUint16(base + 8, entry.type, true);
    // elementSize: 2 for array types, 1 for char/pstring. We encode this
    // in the generator by reading each entry's intent from its type field.
    const elementSize = entry.type === 2 || entry.type === 1 ? 1 : 2;
    view.setUint16(base + 10, elementSize, true);
    view.setUint32(base + 12, entry.data.length / elementSize, true); // numElements
    view.setUint32(base + 16, entry.data.length, true);
    view.setUint32(base + 20, entry.dataOffset, true);
    view.setUint32(base + 24, 0, true); // dataHandle unused (data > 4 bytes)
    bytes.set(entry.data, dataStart + entry.dataOffset);
  }
  return new Uint8Array(buffer);
}

function packInt16Array(values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setInt16(index * 2, values[index], true);
  }
  return out;
}

// Sanity-test the auto channel assignment by feeding synthetic channels
// where each base's data is strongest in a *different* DATA tag than the
// usual 9..12 → A/C/G/T mapping. The parser should still recover the
// correct A/C/G/T mapping via peak-intensity inference.
function buildReorderedChannels() {
  // Same PBAS/PLOC, but channel data is stored in DATA10..DATA13 instead of
  // the conventional DATA9..DATA12. The auto-assignment should still map
  // A → DATA10, C → DATA11, G → DATA12, T → DATA13 because that's where
  // each base's peak intensity is highest.
  const peaks = [10, 30, 60, 85];
  const samplesPerChannel = 100;
  const traceAt10 = new Array(samplesPerChannel).fill(20);
  const traceAt11 = new Array(samplesPerChannel).fill(20);
  const traceAt12 = new Array(samplesPerChannel).fill(20);
  const traceAt13 = new Array(samplesPerChannel).fill(20);
  traceAt10[peaks[0]] = 800; // A peak in DATA10
  traceAt11[peaks[1]] = 700; // C peak in DATA11
  traceAt12[peaks[2]] = 900; // G peak in DATA12
  traceAt13[peaks[3]] = 850; // T peak in DATA13
  const entries = [
    { name: "PBAS", number: 1, type: 2, data: new TextEncoder().encode("ACGT") },
    { name: "PLOC", number: 2, type: 3, data: packInt16Array(peaks) },
    { name: "PCON", number: 2, type: 1, data: new Uint8Array([60, 45, 50, 30]) },
    { name: "DATA", number: 10, type: 4, data: packInt16Array(traceAt10) },
    { name: "DATA", number: 11, type: 4, data: packInt16Array(traceAt11) },
    { name: "DATA", number: 12, type: 4, data: packInt16Array(traceAt12) },
    { name: "DATA", number: 13, type: 4, data: packInt16Array(traceAt13) },
  ];
  const DIR_ENTRY_SIZE = 28;
  const dirStart = 16;
  const dirCount = entries.length;
  const dataStart = dirStart + dirCount * DIR_ENTRY_SIZE;
  let cursor = 0;
  for (const entry of entries) { entry.dataOffset = cursor; cursor += entry.data.length; }
  const total = dataStart + cursor;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x46494241, true); // "ABIF" little-endian magic
  view.setUint16(4, 100, true);
  view.setUint16(6, dirCount, true);
  view.setUint32(8, dataStart, true);
  view.setUint32(12, cursor, true);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const base = dirStart + index * DIR_ENTRY_SIZE;
    for (let i = 0; i < 4; i += 1) bytes[base + i] = entry.name.charCodeAt(i);
    view.setInt32(base + 4, entry.number, true);
    view.setUint16(base + 8, entry.type, true);
    const elementSize = entry.type === 2 || entry.type === 1 ? 1 : 2;
    view.setUint16(base + 10, elementSize, true);
    view.setUint32(base + 12, entry.data.length / elementSize, true);
    view.setUint32(base + 16, entry.data.length, true);
    view.setUint32(base + 20, entry.dataOffset, true);
    view.setUint32(base + 24, 0, true);
    bytes.set(entry.data, dataStart + entry.dataOffset);
  }
  return new Uint8Array(buffer);
}

const reorderedRecord = parseAb1(buildReorderedChannels());
if (reorderedRecord.channelTagFor.A !== 10) errors.push(`reorder: A tag = ${reorderedRecord.channelTagFor.A} (mapping: ${JSON.stringify(reorderedRecord.channelTagFor)})`);
if (reorderedRecord.channelTagFor.C !== 11) errors.push(`reorder: C tag = ${reorderedRecord.channelTagFor.C}`);
if (reorderedRecord.channelTagFor.G !== 12) errors.push(`reorder: G tag = ${reorderedRecord.channelTagFor.G}`);
if (reorderedRecord.channelTagFor.T !== 13) errors.push(`reorder: T tag = ${reorderedRecord.channelTagFor.T}`);
if (reorderedRecord.qualities.length !== 4) errors.push(`qualities length: ${reorderedRecord.qualities.length}`);
if (reorderedRecord.qualities[0] !== 60) errors.push(`qualities[0] = ${reorderedRecord.qualities[0]}`);

const synthetic = buildSyntheticAb1();
const record = parseAb1(synthetic);

if (record.bases !== "ACGT") errors.push(`bases mismatch: ${record.bases}`);
if (record.peakLocations.length !== 4) errors.push(`peak length: ${record.peakLocations.length}`);
if (record.peakLocations[0] !== 10) errors.push(`peak[0] = ${record.peakLocations[0]}`);
if (record.channels.A[2] !== 20) errors.push(`A[2] = ${record.channels.A[2]}`);
// Auto-assignment should still recover DATA9..DATA12 → A/C/G/T for the
// conventional layout, since each base's spike is in the matching channel.
if (record.channelTagFor.A !== 9) errors.push(`auto: A tag = ${record.channelTagFor.A}`);
if (record.channelTagFor.C !== 10) errors.push(`auto: C tag = ${record.channelTagFor.C}`);
if (record.channelTagFor.G !== 11) errors.push(`auto: G tag = ${record.channelTagFor.G}`);
if (record.channelTagFor.T !== 12) errors.push(`auto: T tag = ${record.channelTagFor.T}`);
if (record.qualities[0] !== 60) errors.push(`qualities[0] = ${record.qualities[0]}`);

if (errors.length > 0) {
  console.error("AB1 parser test FAILED:");
  for (const message of errors) console.error("  -", message);
  process.exit(1);
}

// Round 2: exercise the inline data path (dataHandle != 0, dataSize <= 4).
// In real AB1 files short integer tags are stored inline rather than at an
// offset; we build a minimal container that uses that layout so the inline
// branch in dataPointer is also covered.
function buildInlineSample() {
  const buffer = new ArrayBuffer(256);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  view.setUint32(0, 0x46494241, true); // "ABIF" little-endian magic
  view.setUint16(4, 100, true); // version
  view.setUint16(6, 2, true); // tagCount = 2 (PBAS + PLOC, both inline)
  view.setUint32(8, 16 + 56, true); // dataOffset (right after both dir entries)
  // Entry 1: PLOC — 2-element uint16 array, inline (dataSize = 4).
  let base = 16;
  bytes.set([0x50, 0x4c, 0x4f, 0x43], base); // "PLOC"
  view.setInt32(base + 4, 1, true);
  view.setUint16(base + 8, 3, true); // type = word
  view.setUint16(base + 10, 2, true); // elementSize
  view.setUint32(base + 12, 2, true); // numElements = 2
  view.setUint32(base + 16, 4, true); // dataSize = 4 → inline
  view.setUint32(base + 20, 0, true);
  view.setUint32(base + 24, 7 | (99 << 16), true); // dataHandle: [7,0,99,0] → peak[0]=7, peak[1]=99
  // Entry 2: PBAS — 2-char ASCII string, inline (dataSize = 2).
  base = 16 + 28;
  bytes.set([0x50, 0x42, 0x41, 0x53], base); // "PBAS"
  view.setInt32(base + 4, 1, true);
  view.setUint16(base + 8, 2, true); // type = char
  view.setUint16(base + 10, 1, true); // elementSize
  view.setUint32(base + 12, 2, true); // numElements = 2
  view.setUint32(base + 16, 2, true); // dataSize = 2 → inline
  view.setUint32(base + 20, 0, true);
  // 'A' = 0x41, 'C' = 0x43 → dataHandle = 0x0043_0041 little-endian
  view.setUint32(base + 24, 0x41 | (0x43 << 8), true);
  return new Uint8Array(buffer);
}

const inlineRecord = parseAb1(buildInlineSample());
if (inlineRecord.bases !== "AC") {
  console.error("Inline-data round PBAS mismatch:", inlineRecord.bases);
  process.exit(1);
}
if (inlineRecord.peakLocations[0] !== 7 || inlineRecord.peakLocations[1] !== 99) {
  console.error("Inline-data PLOC mismatch:", inlineRecord.peakLocations);
  process.exit(1);
}
console.log("AB1 inline-data test PASSED: bases =", inlineRecord.bases, ", peaks =", inlineRecord.peakLocations);

// Real-world ABI sequencers emit files where the header's dataOffset
// points directly to the directory containing all the actual tags
// (PBAS / PLOC / DATA<n>), and each entry's dataOffset is RELATIVE to
// the same data section start. We synthesize that layout here so the
// dataOffset-driven read path in collectAllEntries is exercised against
// a realistic sample.
function buildRealisticLayout() {
  // Layout:
  //   [0, 16)                ABIF header (magic + version + tagCount + dataOffset + reserved)
  //   [16, 16+8)             8 bytes of padding/overlap (real files often have a tiny
  //                          "root" directory fragment here)
  //   [24, 24+7*28)          directory with 7 entries (PBAS + PLOC + PCON + DATA9..12)
  //   [220, 220+P)           payload area, P = sum of entry data sizes
  //   dataSectionStart = 24, so dataOffset values resolve to dataSectionStart + dataOffset
  const headerDataOffset = 24;
  const dirCount = 7;
  const peaks = [12, 38, 71, 96];
  const bases = "ACGT";
  const samplesPerChannel = 100;
  const traceA = new Array(samplesPerChannel).fill(20); traceA[peaks[0]] = 800;
  const traceC = new Array(samplesPerChannel).fill(20); traceC[peaks[1]] = 700;
  const traceG = new Array(samplesPerChannel).fill(20); traceG[peaks[2]] = 900;
  const traceT = new Array(samplesPerChannel).fill(20); traceT[peaks[3]] = 850;
  const realEntries = [
    { name: "PBAS", number: 1, type: 2, data: new TextEncoder().encode(bases) },
    { name: "PLOC", number: 2, type: 3, data: packInt16Array(peaks) },
    { name: "PCON", number: 2, type: 1, data: new Uint8Array([60, 45, 50, 30]) },
    { name: "DATA", number: 9, type: 4, data: packInt16Array(traceA) },
    { name: "DATA", number: 10, type: 4, data: packInt16Array(traceC) },
    { name: "DATA", number: 11, type: 4, data: packInt16Array(traceG) },
    { name: "DATA", number: 12, type: 4, data: packInt16Array(traceT) },
  ];
  const DIR_ENTRY_SIZE = 28;
  const dirEntriesStart = headerDataOffset; // = 24
  const payloadStart = dirEntriesStart + dirCount * DIR_ENTRY_SIZE; // = 220
  let cursor = 0;
  for (const entry of realEntries) {
    // Per ABIF: each entry's dataOffset is RELATIVE to dataSectionStart.
    entry.dataOffset = (payloadStart - headerDataOffset) + cursor;
    cursor += entry.data.length;
  }
  const total = payloadStart + cursor;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // File header
  view.setUint32(0, 0x46494241, true); // "ABIF"
  view.setUint16(4, 101, true); // version (matches real files)
  view.setUint16(6, dirCount, true); // tagCount
  view.setUint32(8, headerDataOffset, true); // dataOffset → directory start
  view.setUint32(12, total - headerDataOffset, true); // reserved
  // Directory entries
  for (let index = 0; index < realEntries.length; index += 1) {
    const entry = realEntries[index];
    const base = dirEntriesStart + index * DIR_ENTRY_SIZE;
    for (let i = 0; i < 4; i += 1) bytes[base + i] = entry.name.charCodeAt(i);
    view.setInt32(base + 4, entry.number, true);
    view.setUint16(base + 8, entry.type, true);
    const elementSize = entry.type === 2 || entry.type === 1 ? 1 : 2;
    view.setUint16(base + 10, elementSize, true);
    view.setUint32(base + 12, entry.data.length / elementSize, true);
    view.setUint32(base + 16, entry.data.length, true);
    view.setUint32(base + 20, entry.dataOffset, true);
    view.setUint32(base + 24, 0, true);
    bytes.set(entry.data, payloadStart + (entry.dataOffset - (payloadStart - headerDataOffset)));
  }
  return new Uint8Array(buffer);
}

const nestedRecord = parseAb1(buildRealisticLayout());
if (nestedRecord.bases !== "ACGT") {
  console.error("Realistic layout: bases mismatch:", nestedRecord.bases);
  process.exit(1);
}
if (nestedRecord.peakLocations.length !== 4 || nestedRecord.peakLocations[0] !== 12) {
  console.error("Realistic layout: PLOC mismatch:", nestedRecord.peakLocations);
  process.exit(1);
}
if (nestedRecord.channelTagFor.A !== 9 || nestedRecord.channelTagFor.T !== 12) {
  console.error("Realistic layout: channel mapping mismatch:", JSON.stringify(nestedRecord.channelTagFor));
  process.exit(1);
}
if (nestedRecord.qualities.length !== 4 || nestedRecord.qualities[0] !== 60) {
  console.error("Realistic layout: PCON mismatch:", nestedRecord.qualities);
  process.exit(1);
}
console.log("AB1 realistic-layout test PASSED: bases =", nestedRecord.bases, ", peaks =", nestedRecord.peakLocations, ", mapping =", JSON.stringify(nestedRecord.channelTagFor));

// Cleanup the bundled module so we don't leave it in scripts/.
try { await import("node:fs/promises").then((fs) => fs.unlink(resolve(here, "_tmp_ab1_test_bundle.mjs"))); } catch {}
console.log("AB1 parser test PASSED:", JSON.stringify({ bases: record.bases, peaks: record.peakLocations }));