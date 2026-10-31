/**
 * Canvas waveform stroke. Mirrors `--color-secondary` in `src/design_tokens.css`:
 * Canvas 2D needs a literal, and reading the token per paint would force a style
 * flush. If the token changes, update this in lockstep.
 */
export const WAVEFORM_PAINT_COLOR = '#c97cb3';
