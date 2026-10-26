import React from 'react';
import { createPortal } from 'react-dom';
import { dropdownStyles } from 'src/ui/dropdown/dropdown';
import { placeAxis, usePanelSize } from 'src/ui/dropdown/popover_placement';
import { useMenuKeyboard } from 'src/ui/menu_keyboard';

/**
 * A right-click context menu: the SAME floating panel + menu-item components as
 * the header dropdowns ({@link DropdownButton}), but opened at an arbitrary
 * cursor position instead of anchored to a trigger button. Reuses
 * `dropdownStyles.dropdownPanel`, so callers fill it with the regular
 * {@link ActionMenuItem} / `DropdownSection` rows.
 *
 * Portaled to `document.body` and positioned `fixed` at `(x, y)`, flipped or
 * clamped into the viewport. Closes on outside pointer-down or Escape; menu
 * items dismiss it by calling `onClose` from their `onClick`.
 */
export function ContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  // Arrow/Home/End roving focus over the menu rows.
  const { onKeyDown: onPanelKeyDown } = useMenuKeyboard(panelRef);

  React.useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const panelSize = usePanelSize(panelRef, true);
  const pos =
    panelSize == null
      ? { top: y, left: x }
      : {
          top: placeAxis(y, y - panelSize.height, panelSize.height, window.innerHeight),
          left: placeAxis(x, x - panelSize.width, panelSize.width, window.innerWidth),
        };

  return createPortal(
    <div
      ref={panelRef}
      className={dropdownStyles.dropdownPanel}
      role="menu"
      style={{ position: 'fixed', top: pos.top, left: pos.left }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onPanelKeyDown}
    >
      {children}
    </div>,
    document.body
  );
}
