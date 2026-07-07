"""Regenerate `vibrato_cases.json` from real model output.

Not a test (no `test_` prefix -> pytest skips it). It runs the offline f0 model
over Death of a Bachelor's vocal stem and freezes the cleaned per-frame contour
slices at the edge-cases the vibrato detector was tuned against, tagging each
with its expected classification. Re-run this after swapping the pitch model or
retuning the front-end so the regression fixtures reflect current model output:

    scripts/sandbox-run python3 aligner/tests/fixtures/capture_vibrato_cases.py \
        --stem /path/to/death_of_a_bachelor_vocals.flac \
        --model /path/to/rmvpe.onnx

The timestamps are specific to that recording (the underlying vocal events don't
move); a different song would need its own edge-cases identified.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import librosa
import numpy as np

from app.pipeline.pitch import features
from app.pipeline.pitch.rmvpe import Rmvpe

# (name, slice_start, slice_end, event_start, event_end, expect_vibrato, note)
CASES = [
    ("delayed_onset_35s", 34.75, 36.55, 35.35, 36.05, True,
     "note steadies then develops vibrato in its 2nd half"),
    ("split_56s", 55.45, 57.35, 56.05, 56.85, True,
     "wide vibrato that note-segmentation used to chop into sub-min pieces"),
    ("vibrato_66s", 65.75, 67.55, 66.35, 67.05, True, "sustained vibrato"),
    ("vibrato_76s", 75.50, 77.25, 76.10, 76.75, True, "sustained vibrato"),
    ("held_vibrato_39s", 38.25, 39.75, 38.85, 39.45, True,
     "genuine vibrato on a held note, just before the 40s run"),
    ("rise_fall_6s", 5.85, 7.10, 6.05, 6.60, False,
     "single rise into a note + hold + fall out to the next -- one excursion"),
    ("run_40s", 39.45, 41.50, 39.85, 41.05, False,
     "continuous rising/falling melodic run -- centre sweeps many semitones"),
    ("steady_7s", 6.55, 7.70, 6.95, 7.42, False,
     "near-steady held note, no audible wobble"),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stem", required=True, help="Death of a Bachelor vocals stem")
    ap.add_argument("--model", required=True, help="offline f0 model (rmvpe.onnx)")
    ap.add_argument("--out", default=str(Path(__file__).with_name("vibrato_cases.json")))
    args = ap.parse_args()

    audio = librosa.load(args.stem, sr=features.SR, mono=True)[0].astype(np.float32)
    c = Rmvpe(args.model).extract(audio)
    midi = features.clean_contour(
        features.voiced_midi(c.hz, c.confidence, conf_thresh=0.1),
        fps=c.fps, drop_octave_outliers=False,
    )
    fps = c.fps

    out = []
    for name, sa, sb, ea, eb, expect, note in CASES:
        i0, i1 = int(round(sa * fps)), int(round(sb * fps))
        seg = midi[i0:i1]
        ev0, ev1 = int(round((ea - sa) * fps)), int(round((eb - sa) * fps))
        rate, _ = features.detect_vibrato_frames(seg, fps=fps)
        n_vib = int(np.isfinite(rate[ev0:ev1]).sum())
        status = "OK" if (n_vib >= 5) == expect else "MISLABELLED"
        print(f"{name:22s} expect={expect!s:5s} event_vib_frames={n_vib:3d}  {status}")
        out.append({
            "name": name, "note": note, "fps": fps, "expect_vibrato": expect,
            "event": [ev0, ev1],
            "midi": [None if not np.isfinite(v) else round(float(v), 2) for v in seg],
        })

    Path(args.out).write_text(json.dumps(out))
    print(f"wrote {args.out} ({len(out)} cases)")


if __name__ == "__main__":
    main()
