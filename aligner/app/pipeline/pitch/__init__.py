"""Vocal pitch (f0) analysis: RMVPE ONNX -> per-frame pitch contour + vibrato.

Runs over the separated vocals stem (torch-free onnxruntime) right after
separation, returning a cleaned per-frame pitch contour that's a property of the
stem, not the lyrics. The frontend maps it onto aligned words (median pitch, note
sub-segments, vibrato) so it can lay words out vertically by pitch. See
`analyze.extract_pitch_contour`.
"""
