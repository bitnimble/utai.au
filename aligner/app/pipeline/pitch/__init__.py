"""Vocal pitch (f0) analysis: SwiftF0 ONNX -> per-word pitch, melisma, vibrato.

Runs over the separated vocals stem (torch-free onnxruntime), attaching a
median pitch + note sub-segments + vibrato to each aligned lyric word so the
frontend can lay words out vertically by pitch. See `analyze.attach_pitch`.
"""
