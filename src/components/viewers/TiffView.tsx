import { ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { tiffBase64ToPngDataUrl } from "../../lib/tiff";
import type { FilePayload } from "../../types/domain";

interface TiffViewProps {
  payload: FilePayload;
  onOpenExternal: () => void;
}

export default function TiffView({ payload, onOpenExternal }: TiffViewProps) {
  const [pngUrl, setPngUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPngUrl("");
    setFailed(false);
    // Yield once so the loading surface can paint before a large microscopy
    // image is decoded on the browser thread.
    const timer = window.setTimeout(() => {
      const converted = tiffBase64ToPngDataUrl(payload.content);
      if (cancelled) return;
      if (converted) setPngUrl(converted);
      else setFailed(true);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [payload.content]);

  if (failed) {
    return (
      <div className="viewer-state viewer-state--error">
        <strong>无法解码此 TIFF 图像</strong>
        <span>{payload.relativePath}</span>
        <button type="button" onClick={onOpenExternal}><ExternalLink size={15} /> 使用系统程序打开</button>
      </div>
    );
  }

  if (!pngUrl) {
    return <div className="viewer-state"><LoaderCircle className="spin" size={24} /><span>正在解码 TIFF 图像…</span></div>;
  }

  return <div className="image-viewer"><img src={pngUrl} alt={payload.name} /></div>;
}
