import { useEffect, useRef, useState } from "react";
import { init as initPptx } from "pptx-preview";
import { decodeBase64 } from "../../lib/bridge";
import type { FilePayload } from "../../types/domain";
import { ViewerError } from "./shared";

export default function PptxView({ payload }: { payload: FilePayload }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.replaceChildren();
    try {
      const previewer = initPptx(host, { width: 960, height: 540 });
      void Promise.resolve(previewer.preview(decodeBase64(payload.content))).catch((reason) => setError(String(reason)));
    } catch (reason) {
      setError(String(reason));
    }
  }, [payload.content]);
  if (error) return <ViewerError message={error} />;
  return <div className="pptx-scroll"><div className="pptx-viewer" ref={hostRef} /></div>;
}
