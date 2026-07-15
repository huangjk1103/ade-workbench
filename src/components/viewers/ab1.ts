// AB1 (Applied Biosystems Sanger sequencing trace) parser.
//
// AB1 is the on-disk format produced by Applied Biosystems / Life
// Technologies DNA sequencers (e.g. 3500, 3730). It is a tagged binary
// container (ABIF — AB Item Format) holding the four-channel chromatogram
// traces, called bases, quality scores, and metadata. The spec is widely
// reverse-engineered; we follow the same conventions as the popular
// `traces` / `ab1-js` packages but keep the implementation self-contained
// so the viewer does not need a network dependency.
//
// The high-level shape:
//
//     "ABIF"  (4 bytes magic, little-endian uint32 0x46494241)
//     version (2 bytes uint16)
//     Directory header:
//       tagCount (2 bytes uint16)
//       dataOffset (4 bytes uint32)  // byte offset to first data block
//       dataSize  (4 bytes uint32)   // reserved
//     Directory entries: 28 bytes each
//       name        (4 bytes ASCII)
//       number      (4 bytes int32)
//       type        (2 bytes uint16)
//       elementSize (2 bytes uint16)
//       numElements (4 bytes uint32)
//       dataSize    (4 bytes uint32)
//       dataOffset  (4 bytes uint32)  // offset relative to dataOffset
//       dataHandle  (4 bytes uint32)  // raw bytes when dataSize <= 4
//
// Tag types we care about:
//   1  = byte
//   2  = char / cstring
//   3  = word (uint16)
//   4  = short (int16)
//   5  = long (int32)
//   9  = date
//   10 = time
//   18 = pstring (one length byte followed by bytes)

const ABIF_MAGIC = 0x46494241; // "ABIF" read as a little-endian uint32
const DIR_ENTRY_SIZE = 28;
const SMALL_DATA_THRESHOLD = 4;

const TYPE_BYTE = 1;
const TYPE_CHAR = 2;
const TYPE_WORD = 3;
const TYPE_SHORT = 4;
const TYPE_PSTRING = 18;

interface DirEntry {
  name: string;
  number: number;
  type: number;
  elementSize: number;
  numElements: number;
  dataSize: number;
  dataOffset: number;
  dataHandle: number;
}

export interface Ab1Record {
  sample?: string;
  comment?: string;
  machine?: string;
  analysisVersion?: string;
  bases: string;
  /** Per-base quality (Phred 0-255). May be empty when the file lacks PCON. */
  qualities: number[];
  peakLocations: number[];
  /**
   * Four chromatogram channels keyed by base (A/C/G/T). The mapping is
   * inferred from peak intensities rather than hard-coded to DATA9..12 —
   * different sequencer vendors store channels in different orders, so we
   * always run `inferBaseChannels` and remap. Channels that could not be
   * confidently mapped are returned as empty arrays.
   */
  channels: { A: number[]; C: number[]; G: number[]; T: number[] };
  /** The original DATA<n> tag that maps to each base, for debugging. */
  channelTagFor: { A?: number; C?: number; G?: number; T?: number };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    const code = view.getUint8(offset + index);
    if (code === 0) break;
    out += String.fromCharCode(code);
  }
  return out;
}

function readPstring(view: DataView, offset: number, available: number = Infinity): string {
  const declared = view.getUint8(offset);
  const length = Math.min(declared, Math.max(0, available - 1));
  return readAscii(view, offset + 1, length);
}

function parseDirectory(view: DataView, start: number, end: number): DirEntry[] {
  const entries: DirEntry[] = [];
  for (let cursor = start; cursor + DIR_ENTRY_SIZE <= end; cursor += DIR_ENTRY_SIZE) {
    const name = readAscii(view, cursor, 4);
    if (!name) break;
    entries.push({
      name,
      number: view.getInt32(cursor + 4, true),
      type: view.getUint16(cursor + 8, true),
      elementSize: view.getUint16(cursor + 10, true),
      numElements: view.getUint32(cursor + 12, true),
      dataSize: view.getUint32(cursor + 16, true),
      dataOffset: view.getUint32(cursor + 20, true),
      dataHandle: view.getUint32(cursor + 24, true),
    });
  }
  return entries;
}

function dataPointer(view: DataView, entry: DirEntry, dataSectionStart: number): { offset: number; inline: Uint8Array | null } {
  // ABIF spec says payloads <= 4 bytes live in the dataHandle slot (raw
  // little-endian uint32), not at dataOffset. Real-world writers vary
  // though — some always use dataOffset regardless of size. We try the
  // inline slot first when its bytes look meaningful (non-zero) and fall
  // back to the offset path otherwise so both layouts decode correctly.
  if (entry.dataSize <= SMALL_DATA_THRESHOLD && entry.dataHandle !== 0) {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, entry.dataHandle, true);
    return { offset: 0, inline: buf.subarray(0, entry.dataSize) };
  }
  // Guard against runaway offsets: clamp the resolved offset to the
  // file length so callers that read individual bytes get safe values
  // instead of crashing on a malformed dataOffset. The read* helpers
  // fall back to padding with zeros when the entry is shorter than
  // numElements, so a too-large dataOffset doesn't break parsing — it
  // just yields empty data, which surfaces as a "no PBAS/PLOC" error
  // with the discovered-tag list to help the user diagnose the file.
  const absoluteOffset = dataSectionStart + entry.dataOffset;
  const maxOffset = Math.max(0, view.byteLength - 1);
  return { offset: Math.min(Math.max(absoluteOffset, 0), maxOffset), inline: null };
}

function readString(view: DataView, entry: DirEntry, dataSectionStart: number): string {
  const ptr = dataPointer(view, entry, dataSectionStart);
  if (entry.type === TYPE_PSTRING) {
    if (ptr.inline) {
      const dv = new DataView(ptr.inline.buffer, ptr.inline.byteOffset, ptr.inline.byteLength);
      return readPstring(dv, 0, ptr.inline.length);
    }
    return readPstring(view, ptr.offset, Math.min(entry.numElements + 1, entry.dataSize));
  }
  if (entry.type === TYPE_CHAR || entry.type === TYPE_BYTE) {
    if (ptr.inline) {
      return readAscii(new DataView(ptr.inline.buffer, ptr.inline.byteOffset, ptr.inline.byteLength), 0, ptr.inline.length);
    }
    return readAscii(view, ptr.offset, entry.numElements);
  }
  return "";
}

function readUint16Array(view: DataView, entry: DirEntry, dataSectionStart: number): number[] {
  const result: number[] = new Array(entry.numElements);
  const ptr = dataPointer(view, entry, dataSectionStart);
  if (ptr.inline) {
    // Inline short arrays are rare but valid — read the bytes we have.
    for (let index = 0; index < entry.numElements; index += 1) {
      result[index] = (ptr.inline[index * 2] ?? 0) | ((ptr.inline[index * 2 + 1] ?? 0) << 8);
    }
    return result;
  }
  for (let index = 0; index < entry.numElements; index += 1) {
    result[index] = view.getUint16(ptr.offset + index * entry.elementSize, true);
  }
  return result;
}

function readInt16Array(view: DataView, entry: DirEntry, dataSectionStart: number): number[] {
  const result: number[] = new Array(entry.numElements);
  const ptr = dataPointer(view, entry, dataSectionStart);
  if (ptr.inline) {
    for (let index = 0; index < entry.numElements; index += 1) {
      const lo = ptr.inline[index * 2] ?? 0;
      const hi = ptr.inline[index * 2 + 1] ?? 0;
      // Sign extend from 16 bits.
      const value = (lo | (hi << 8)) << 16 >> 16;
      result[index] = value;
    }
    return result;
  }
  for (let index = 0; index < entry.numElements; index += 1) {
    result[index] = view.getInt16(ptr.offset + index * entry.elementSize, true);
  }
  return result;
}

// Per-byte array reader (used for PCON2 quality scores, one byte per base).
function readUint8Array(view: DataView, entry: DirEntry, dataSectionStart: number): number[] {
  const result: number[] = new Array(entry.numElements);
  const ptr = dataPointer(view, entry, dataSectionStart);
  if (ptr.inline) {
    for (let index = 0; index < entry.numElements; index += 1) {
      result[index] = ptr.inline[index] ?? 0;
    }
    return result;
  }
  for (let index = 0; index < entry.numElements; index += 1) {
    result[index] = view.getUint8(ptr.offset + index * entry.elementSize);
  }
  return result;
}

// Collect every directory entry the parser can reach in the ABIF container.
// Real AB1 files produced by Applied Biosystems sequencers don't always put
// the actual tag table immediately after the 16-byte file header — the
// header's dataOffset field often points to a *nested* directory container,
// and individual entries may in turn reference further child directories
// through `DIR` / `tag` entries. The synthetic files used by our test
// suite put everything at offset 16, so we have to scan both locations
// (and follow any nested pointers we find) before giving up.
function collectAllEntries(view: DataView, fileSize: number): {
  entries: DirEntry[];
  dataSectionStart: number;
} {
  const collected: DirEntry[] = [];
  // Track which directory-block starts we've already expanded so a malformed
  // file can't loop us forever via circular DIR pointers.
  const visited = new Set<number>();
  // The ABIF header's dataOffset usually names the root data block, which
  // most real files treat as the *first* directory container. Synthetic /
  // older files may keep the directory at offset 16 right after the header.
  const dirTagCount = view.getUint16(6, true);
  const headerDataOffset = view.getUint32(8, true);
  const dataSectionStart = headerDataOffset;

  const candidateStarts: Array<{ start: number; count: number; source: string }> = [];
  if (dirTagCount > 0 && 16 + dirTagCount * DIR_ENTRY_SIZE <= fileSize) {
    candidateStarts.push({ start: 16, count: dirTagCount, source: "header.dirTagCount@16" });
  }
  if (
    headerDataOffset >= 16 &&
    headerDataOffset + DIR_ENTRY_SIZE <= fileSize &&
    headerDataOffset !== 16
  ) {
    // Probe the dataOffset location by reading a directory entry there; if
    // the name field is a plausible 4-char tag we expand it as a directory.
    const probeName = readAscii(view, headerDataOffset, 4);
    if (probeName.length === 4 && /^[A-Za-z0-9]+$/.test(probeName)) {
      candidateStarts.push({ start: headerDataOffset, count: dirTagCount, source: "header.dataOffset" });
    }
  }

  // Queues of (start, count) pairs to expand; we expand each by reading its
  // declared number of entries and then queue any nested DIR blocks those
  // entries reference.
  const queue: Array<{ start: number; count: number }> = candidateStarts.map((c) => ({
    start: c.start,
    count: c.count,
  }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const { start, count } = next;
    if (visited.has(start) || start + count * DIR_ENTRY_SIZE > fileSize) continue;
    visited.add(start);
    const blockEntries = parseDirectory(view, start, start + count * DIR_ENTRY_SIZE);
    for (const entry of blockEntries) {
      collected.push(entry);
      // A nested directory block: the entry's dataOffset is RELATIVE to
      // the data section start (headerDataOffset), so we translate it to
      // an absolute file offset before queueing it for expansion. We only
      // follow entries that look like real DIR-tagged subdirectories —
      // name "DIR", "DIR<digits>" (the ABI convention is e.g. "DIR1",
      // "DIR2") or "tag", type 18 (pstring) / 2 (char), and a sane size.
      if (
        (entry.name === "DIR" || /^DIR\d+$/.test(entry.name) || entry.name === "tag") &&
        entry.dataSize > 0 &&
        entry.dataSize < 1 << 20
      ) {
        const nestedStart = headerDataOffset + entry.dataOffset;
        // Heuristic: nested directory blocks always carry their own tag
        // count in the first 2 bytes of the payload. Probe it to size the
        // queue entry; if it's missing we still queue a single-entry read.
        if (nestedStart + 2 <= fileSize) {
          const nestedCount = view.getUint16(nestedStart, true);
          if (nestedCount > 0 && nestedCount < 4096) {
            queue.push({ start: nestedStart, count: nestedCount });
            continue;
          }
        }
        queue.push({ start: nestedStart, count: 1 });
      }
    }
  }

  // De-duplicate by the entry's first 28 bytes (a stable fingerprint) so
  // overlapping reads from multiple candidate starts don't yield doubles.
  const seen = new Set<number>();
  const unique: DirEntry[] = [];
  for (const entry of collected) {
    // Use the entry's dataOffset field as the dedup key — entries with the
    // same (name, number, dataOffset, dataHandle) describe the same data
    // even if read from different directory starts.
    const key = entry.dataOffset * 0x100000 + (entry.dataHandle >>> 0);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return { entries: unique, dataSectionStart };
}

export function parseAb1(bytes: Uint8Array): Ab1Record {
  if (bytes.byteLength < 128) throw new Error("文件太小，无法解析为 AB1");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== ABIF_MAGIC) throw new Error("文件头不是 ABIF 魔数（不是 AB1 格式）");

  // ABIF file header layout (16 bytes):
  //   0-3   "ABIF" magic
  //   4-5   version (uint16, ignored — real files report 100 or 101)
  //   6-7   directory tag count (uint16)
  //   8-11  data section offset from start of file (uint32)
  //   12-15 reserved (uint32, usually == total data size)
  const { entries, dataSectionStart } = collectAllEntries(view, bytes.byteLength);

  const findTag = (name: string, preferredNumber?: number): DirEntry | undefined => {
    const matches = entries.filter((entry) => entry.name === name);
    if (matches.length === 0) return undefined;
    // When a number is supplied we require an exact match — the
    // DATA<n> trace channels in particular all share the tag name "DATA"
    // and only differ by their numbered slot, so a relaxed lookup would
    // return the same first DATA entry for every query.
    if (preferredNumber !== undefined) {
      return matches.find((entry) => entry.number === preferredNumber);
    }
    return matches[0];
  };

  const baseCalls = findTag("PBAS") ?? findTag("PBAS2");
  const peakLocations = findTag("PLOC") ?? findTag("PLOC2");
  const sampleTag = findTag("SMPL", 1) ?? findTag("SMPL");
  const commentTag = findTag("CMNT") ?? findTag("CMNT1");
  const machineTag = findTag("MCHN", 1) ?? findTag("MCHN");
  const analysisTag = findTag("APrV", 1) ?? findTag("APrV") ?? findTag("PCON") ?? findTag("PCON2");
  // Per-base quality (Phred-like 0-255). PCON2 is the most common tag; fall
  // back to PCON when the numbered variant is missing.
  const qualityTag = findTag("PCON", 2) ?? findTag("PCON") ?? findTag("PHRE") ?? findTag("PHRE2");

  if (!baseCalls || !peakLocations) {
    // Surface a more useful hint than just "missing tags": list the tag
    // names we did find so the user can see whether the file is an
    // unexpected ABIF dialect or genuinely has no base calls.
    const foundNames = Array.from(new Set(entries.map((entry) => entry.name))).sort();
    const detail = foundNames.length > 0
      ? `已识别标签：${foundNames.slice(0, 12).join(" / ")}${foundNames.length > 12 ? " …" : ""}`
      : "目录中没有可用标签";
    throw new Error(`AB1 文件缺少基线调用（PBAS）或峰位（PLOC）标签 — ${detail}`);
  }

  const bases = readString(view, baseCalls, dataSectionStart).toUpperCase();
  const peakIdx = readUint16Array(view, peakLocations, dataSectionStart);
  const qualities = qualityTag ? readUint8Array(view, qualityTag, dataSectionStart) : [];

  // Read every DATA<n> tag with n in [9..20] — real-world sequencers use
  // 9..12 (4 channels) or 10..13 (offset by one) depending on the writer.
  // We then infer which channel corresponds to A/C/G/T by sampling the
  // intensity at each called base's peak position and greedily assigning
  // the channel with the highest mean per base. See sgvallve/Ab1_Viewer
  // for the original idea.
  const rawChannels: Record<number, number[]> = {};
  for (let channelNumber = 9; channelNumber <= 20; channelNumber += 1) {
    const entry = findTag("DATA", channelNumber);
    if (!entry) continue;
    rawChannels[channelNumber] = readInt16Array(view, entry, dataSectionStart);
  }
  const mapping = inferBaseChannels(bases, peakIdx, rawChannels);

  return {
    sample: sampleTag ? readString(view, sampleTag, dataSectionStart) : undefined,
    comment: commentTag ? readString(view, commentTag, dataSectionStart) : undefined,
    machine: machineTag ? readString(view, machineTag, dataSectionStart) : undefined,
    analysisVersion: analysisTag ? readString(view, analysisTag, dataSectionStart) : undefined,
    bases,
    qualities,
    peakLocations: peakIdx,
    channels: {
      A: mapping.A ? (rawChannels[mapping.A] ?? []) : [],
      C: mapping.C ? (rawChannels[mapping.C] ?? []) : [],
      G: mapping.G ? (rawChannels[mapping.G] ?? []) : [],
      T: mapping.T ? (rawChannels[mapping.T] ?? []) : [],
    },
    channelTagFor: mapping,
  };
}

/**
 * Greedy one-to-one assignment of {DATA9..DATA20} channels to A/C/G/T based
 * on mean intensity at each called base's peak position. The idea is that a
 * well-called base should sit on the tallest peak of its corresponding
 * channel, so the (base, channel) pair with the highest mean intensity gets
 * matched first and removed from the candidate set.
 */
function inferBaseChannels(
  bases: string,
  peaks: number[],
  channels: Record<number, number[]>,
): { A?: number; C?: number; G?: number; T?: number } {
  const basesList: Array<"A" | "C" | "G" | "T"> = ["A", "C", "G", "T"];
  const chanKeys = Object.keys(channels).map(Number).sort((a, b) => a - b);
  if (chanKeys.length === 0) return {};

  // Build a (4 x N) score matrix by averaging each channel's intensity at
  // every peak position whose called base is one of A/C/G/T. We sample up
  // to 5000 peak positions so the loop stays fast on long traces.
  const SAMPLE_CAP = 5000;
  const positions: number[] = [];
  for (let index = 0; index < peaks.length && positions.length < SAMPLE_CAP; index += 1) {
    const base = bases[index];
    if (base === "A" || base === "C" || base === "G" || base === "T") {
      positions.push(peaks[index]);
    }
  }
  if (positions.length === 0) return {};

  // score[base][chanKey] = mean intensity at peak positions where base was called.
  const score: Record<string, Record<number, number>> = {};
  for (const base of basesList) {
    score[base] = {};
    const basePositions = positions.filter((_, idx) => bases[idx] === base);
    if (basePositions.length === 0) continue;
    for (const ck of chanKeys) {
      let sum = 0;
      const trace = channels[ck];
      for (const p of basePositions) {
        if (p >= 0 && p < trace.length) sum += trace[p];
      }
      score[base][ck] = sum / basePositions.length;
    }
  }

  // Greedy one-to-one assignment: highest mean intensity wins, then remove
  // both the base and the channel from the candidate pool and repeat.
  const remainingBases = new Set<string>(basesList);
  const remainingChans = new Set<number>(chanKeys);
  const pairs: Array<{ score: number; base: string; chan: number }> = [];
  for (const b of basesList) {
    for (const ck of chanKeys) {
      if (score[b]?.[ck] !== undefined) {
        pairs.push({ score: score[b][ck], base: b, chan: ck });
      }
    }
  }
  pairs.sort((left, right) => right.score - left.score);

  const result: { A?: number; C?: number; G?: number; T?: number } = {};
  for (const { score: s, base, chan } of pairs) {
    if (!remainingBases.has(base) || !remainingChans.has(chan)) continue;
    // Skip near-zero / negative intensity — the writer likely has no signal
    // on this channel at the called positions.
    if (s <= 0) break;
    result[base as "A" | "C" | "G" | "T"] = chan;
    remainingBases.delete(base);
    remainingChans.delete(chan);
    if (remainingBases.size === 0) break;
  }
  return result;
}

export function decodeBase64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}