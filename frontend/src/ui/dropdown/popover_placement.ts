import React from 'react';

export const VIEWPORT_MARGIN_PX = 8;

export type PanelSize = { width: number; height: number };

/**
 * One axis of a floating panel's viewport position: `preferred` if the panel
 * fits there, else `fallback` (typically the flipped side of the anchor), else
 * `preferred` clamped into the viewport.
 */
export function placeAxis(
  preferred: number,
  fallback: number,
  panelLength: number,
  viewportLength: number,
): number {
  const max = viewportLength - panelLength - VIEWPORT_MARGIN_PX;
  const fits = (start: number) => start >= VIEWPORT_MARGIN_PX && start <= max;
  if (fits(preferred)) return preferred;
  if (fits(fallback)) return fallback;
  return Math.max(VIEWPORT_MARGIN_PX, Math.min(preferred, max));
}

/** Tracks the rendered size of `panelRef` while `active`; null until first measured. */
export function usePanelSize(
  panelRef: React.RefObject<HTMLElement | null>,
  active: boolean,
): PanelSize | null {
  const [size, setSize] = React.useState<PanelSize | null>(null);
  React.useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!active || panel == null) {
      setSize(null);
      return;
    }
    const measure = () => {
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      setSize((s) => (s?.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panelRef, active]);
  return size;
}
