// utif2 ships as CommonJS (`module.exports = UTIF`), so Vite can expose it
// either directly or behind a synthetic default export.
import * as UTIFns from "utif2";

const UTIF: typeof UTIFns = (UTIFns as any).decode
  ? UTIFns
  : ((UTIFns as any).default ?? UTIFns);

export function tiffBase64ToPngDataUrl(tiffBase64: string): string | null {
  try {
    const binary = atob(tiffBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    const ifds = UTIF.decode(bytes.buffer);
    if (!ifds.length) return null;
    const ifd = ifds[0];
    UTIF.decodeImage(bytes.buffer, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const canvas = document.createElement("canvas");
    canvas.width = ifd.width;
    canvas.height = ifd.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    const imageData = context.createImageData(ifd.width, ifd.height);
    imageData.data.set(rgba);
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

export function isTiffDataUrl(value: string): boolean {
  const match = /^data:([^;,]*);base64,(.*)$/is.exec(value);
  if (!match) return false;
  const mime = match[1].toLowerCase();
  const payload = match[2].replace(/\s/g, "");
  // II*\0 and MM\0* are the little- and big-endian TIFF signatures. Their
  // base64 prefixes are SUkq and TU0A respectively. pptx-preview sometimes
  // emits the unhelpful MIME `image/*`, so signature detection is required.
  return mime.includes("tif") || payload.startsWith("SUkq") || payload.startsWith("TU0A");
}

export function tiffDataUrlToPngDataUrl(value: string): string | null {
  const match = /^data:[^;,]*;base64,(.*)$/is.exec(value);
  return match ? tiffBase64ToPngDataUrl(match[1].replace(/\s/g, "")) : null;
}
