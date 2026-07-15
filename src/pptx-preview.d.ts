declare module "pptx-preview" {
  export interface PptxDocument {
    width: number;
    height: number;
    slides: unknown[];
  }

  export interface PptxPreviewer {
    readonly slideCount: number;
    currentIndex: number;
    pptx: PptxDocument;
    preview(buffer: ArrayBuffer): Promise<unknown>;
    load(buffer: ArrayBuffer): Promise<PptxDocument>;
    renderSingleSlide(slideIndex: number): void;
    destroy(): void;
  }

  export function init(
    element: HTMLElement,
    options?: { width?: number; height?: number; mode?: "list" | "slide"; renderer?: string },
  ): PptxPreviewer;
}
