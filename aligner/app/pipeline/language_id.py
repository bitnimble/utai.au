"""Spoken-language ID of a vocals stem, so the lyrics search can prefer lyrics
written in the sung language's own script over romanised ones.

VoxLingua107 ECAPA-TDNN (SpeechBrain `lang-id-voxlingua107-ecapa`, Apache-2.0):
107 languages, trained on YouTube speech. The STFT front end runs in numpy; the
ONNX graph takes the power spectrogram through the mel filterbank, ECAPA and the
classifier to per-language log-probs, with the label codes in its metadata.
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from app.config import settings
from app.lazy import Lazy

log = logging.getLogger(__name__)

SR = 16_000
N_FFT = 400
HOP = 160
_CHUNK_SEC = 10
_MAX_CHUNKS = 6
_LABELS_KEY = "labels"


def detect_language(vocals_path: str | Path) -> dict | None:
    """`{"language": code, "confidence": p}`, the VoxLingua107 code (ISO 639-1-ish:
    "ja", "zh", "ko", "iw" for Hebrew) and its mean probability over the stem's
    loudest chunks. None when the model isn't provisioned or the stem is empty."""
    lid = model.get()
    if lid is None:
        log.info("language: model not provisioned")
        return None
    from app.pipeline.lyrics_onnx import load_audio_np

    chunks = loudest_chunks(load_audio_np(vocals_path))
    if chunks.shape[0] == 0:
        return None
    probs = np.exp(lid.log_probs(chunks)).mean(axis=0)
    best = int(probs.argmax())
    language, confidence = lid.labels[best], round(float(probs[best]), 3)
    log.info("language: %s (%.3f)", language, confidence)
    return {"language": language, "confidence": confidence}


def loudest_chunks(audio: np.ndarray) -> np.ndarray:
    """Up to `_MAX_CHUNKS` non-silent `_CHUNK_SEC` chunks, loudest first, as
    (chunks, samples). A stem shorter than one chunk is one chunk."""
    n = _CHUNK_SEC * SR
    chunks = audio[None] if audio.shape[0] < n else audio[: audio.shape[0] // n * n].reshape(-1, n)
    rms = np.sqrt(np.mean(np.square(chunks, dtype=np.float64), axis=1))
    order = np.argsort(-rms)[:_MAX_CHUNKS]
    return np.ascontiguousarray(chunks[order[rms[order] > 0]], dtype=np.float32)


def power_spectrogram(chunks: np.ndarray) -> np.ndarray:
    """SpeechBrain's `STFT` + `spectral_magnitude`: periodic Hamming, centred
    with zero padding. (chunks, samples) -> (chunks, frames, N_FFT // 2 + 1)."""
    import librosa

    stft = librosa.stft(
        chunks, n_fft=N_FFT, hop_length=HOP, win_length=N_FFT,
        window="hamming", center=True, pad_mode="constant",
    )
    return np.ascontiguousarray(np.square(np.abs(stft)).transpose(0, 2, 1), dtype=np.float32)


class LanguageId:
    def __init__(self, onnx_path: str | Path) -> None:
        import onnxruntime as ort

        from app.pipeline.onnx_cuda import log_bound_ep

        self._sess = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        log_bound_ep(self._sess, onnx_path)
        self._input_name = self._sess.get_inputs()[0].name
        self.labels = self._sess.get_modelmeta().custom_metadata_map[_LABELS_KEY].split(",")

    def log_probs(self, chunks: np.ndarray) -> np.ndarray:
        return self._sess.run(None, {self._input_name: power_spectrogram(chunks)})[0]


def export_language_id_model(out_path: str | Path, *, opset: int = 17) -> Path:
    """Export SpeechBrain's VoxLingua107 ECAPA classifier (power spectrogram ->
    log-probs). Build side only: needs torch + speechbrain."""
    import tempfile

    import onnx
    import torch
    from speechbrain.inference.classifiers import EncoderClassifier

    with tempfile.TemporaryDirectory() as savedir:
        classifier = EncoderClassifier.from_hparams(
            source="speechbrain/lang-id-voxlingua107-ecapa", savedir=savedir, run_opts={"device": "cpu"}
        )
    mods = classifier.mods

    class Body(torch.nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.fbank = mods.compute_features.compute_fbanks
            self.embedding = mods.embedding_model
            self.classifier = mods.classifier

        def forward(self, power):
            feats = self.fbank(power)
            # InputNormalization(norm_type="sentence", std_norm=False) over whole chunks.
            feats = feats - feats.mean(dim=1, keepdim=True)
            return self.classifier(self.embedding(feats)).squeeze(1)

    encoder = classifier.hparams.label_encoder
    labels = [encoder.decode_ndim(i).split(":")[0] for i in range(len(encoder))]
    out_path = Path(out_path)
    with torch.no_grad():
        torch.onnx.export(
            Body().eval(), (torch.zeros(1, 1001, N_FFT // 2 + 1),), str(out_path),
            input_names=["power"], output_names=["log_probs"],
            dynamic_axes={"power": {0: "batch", 1: "frames"}, "log_probs": {0: "batch"}},
            opset_version=opset, do_constant_folding=True, dynamo=False,
        )
    model_proto = onnx.load(str(out_path))
    onnx.helper.set_model_props(model_proto, {_LABELS_KEY: ",".join(labels)})
    onnx.save(model_proto, str(out_path))
    return out_path


def _build_model() -> LanguageId | None:
    from app.pipeline.provision import provisioned_file

    path = provisioned_file(settings.language_id_model)
    return LanguageId(path) if path is not None else None


model: Lazy[LanguageId | None] = Lazy(_build_model)
