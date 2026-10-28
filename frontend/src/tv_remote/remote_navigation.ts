import { TV_BACK } from './tv';

export type Direction = 'up' | 'down' | 'left' | 'right';

export type Box = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;

const DIRECTIONS: Partial<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';
const OWNS_HORIZONTAL =
  'input:not([type="checkbox"]), textarea, [role="slider"], [role="tablist"], [role="radiogroup"]';
const OWNS_ALL = 'select, [role="menu"], [role="listbox"]';
const LAYER = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]';
const DIALOG = '[role="dialog"], [role="alertdialog"]';

const TOGGLES = new Set(['checkbox', 'radio']);
const UNTYPED = new Set([...TOGGLES, 'range', 'button', 'submit', 'reset', 'color', 'file', 'image']);
const LOCKED = 'data-remote-locked';

const OVERLAP = 2;
const ACROSS_WEIGHT = 2;

/**
 * Moves the focus with a TV remote's D-pad, which the WebView delivers as arrow keys: to the
 * nearest control that way. Controls that move through themselves (menus, sliders, tabs) keep
 * their arrows. Also installs the page's half of the Back button.
 */
export function followRemote(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const active = document.activeElement;
    // A remote's centre button is Enter, and a native box toggles on Space alone.
    if (e.key === 'Enter' && active instanceof HTMLInputElement && TOGGLES.has(active.type)) {
      // Held, the button repeats, which would flip the box back.
      if (!e.repeat) active.click();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === 'Enter' && isTyped(active) && active.hasAttribute(LOCKED)) {
      unlock(active);
      // Focused again, now editable, which is what brings the keyboard up.
      active.blur();
      active.focus();
      // Else the field's own Enter handler submits what it already holds.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const direction = DIRECTIONS[e.key];
    if (direction == null) return;
    const dialog = active instanceof HTMLElement && active.matches(DIALOG) ? active : null;
    if (!(active instanceof HTMLElement) || active === document.body || dialog != null) {
      // Start in the top layer: what is behind a modal is unreachable.
      const layer = dialog ?? openLayers().at(-1);
      const first = focusables(layer ?? document.body)[0];
      if (first == null) return;
      focusFromRemote(first);
    } else {
      const horizontal = direction === 'left' || direction === 'right';
      if (active.closest(OWNS_ALL) != null) return;
      if (horizontal && active.closest(OWNS_HORIZONTAL) != null && !active.hasAttribute(LOCKED)) return;
      focusToward(active, direction);
    }
    // Spent even where nothing lies that way, so a page-level arrow handler can't act on it.
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, { capture: true });
  window[TV_BACK] = goBack;
  return () => {
    window.removeEventListener('keydown', onKey, { capture: true });
    delete window[TV_BACK];
  };
}

/** Focuses the nearest control in `direction`; false where nothing lies that way. */
export function focusToward(from: HTMLElement, direction: Direction): boolean {
  const candidates = focusables(from.closest(LAYER) ?? document.body).filter(
    (each) => !each.contains(from) && !from.contains(each),
  );
  const best = nearest(
    from.getBoundingClientRect(),
    candidates.map((each) => each.getBoundingClientRect()),
    direction,
  );
  if (best == null) return false;
  focusFromRemote(candidates[best]);
  return true;
}

/** Index of the box nearest `from` in `direction`, or null where none lies that way. */
export function nearest(from: Box, boxes: readonly Box[], direction: Direction): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  boxes.forEach((box, i) => {
    const distance = distanceToward(from, box, direction);
    if (distance != null && distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

/** A text field arrives read-only, so its keyboard waits for OK rather than opening on the way past. */
function focusFromRemote(element: HTMLElement): void {
  if (isTyped(element) && !element.readOnly) {
    element.readOnly = true;
    element.setAttribute(LOCKED, '');
    element.addEventListener('blur', () => unlock(element), { once: true });
  }
  element.focus();
}

function unlock(field: HTMLInputElement | HTMLTextAreaElement): void {
  if (!field.hasAttribute(LOCKED)) return;
  field.removeAttribute(LOCKED);
  field.readOnly = false;
}

function isTyped(element: Element | null): element is HTMLInputElement | HTMLTextAreaElement {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && !UNTYPED.has(element.type))
  );
}

/** The remote's Back: whatever is open closes on it. False when nothing used it, which leaves the app. */
function goBack(): boolean {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const inLayer = active.closest(`${LAYER}, [aria-haspopup][aria-expanded="true"]`) != null;
  const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
  // Popups close on Escape without preventing its default.
  return !active.dispatchEvent(escape) || inLayer;
}

/** Open dialogs and popups in document order, which for portals is the order they opened in. */
function openLayers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(LAYER)].filter((each) =>
    each.checkVisibility({ checkVisibilityCSS: true }),
  );
}

function focusables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (each) =>
      each.tabIndex >= 0 &&
      !each.matches(':disabled') &&
      each.closest('[inert]') == null &&
      each.checkVisibility({ checkVisibilityCSS: true }),
  );
}

function distanceToward(from: Box, to: Box, direction: Direction): number | null {
  const vertical = direction === 'up' || direction === 'down';
  const gap = {
    right: to.left - from.right,
    left: from.left - to.right,
    down: to.top - from.bottom,
    up: from.top - to.bottom,
  }[direction];
  if (gap < -OVERLAP) return null;
  const across = vertical
    ? apart(from.left, from.right, to.left, to.right)
    : apart(from.top, from.bottom, to.top, to.bottom);
  return Math.max(gap, 0) + across * ACROSS_WEIGHT;
}

function apart(fromStart: number, fromEnd: number, toStart: number, toEnd: number): number {
  return Math.max(0, toStart - fromEnd, fromStart - toEnd);
}
