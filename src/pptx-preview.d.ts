declare module "pptx-preview" {
  export interface PptxPreviewer {
    preview(buffer: ArrayBuffer): Promise<void> | void;
  }

  export function init(
    element: HTMLElement,
    options?: { width?: number; height?: number },
  ): PptxPreviewer;
}

