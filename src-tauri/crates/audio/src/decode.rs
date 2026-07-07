//! Decode encoded audio bytes to interleaved-stereo f32 PCM via symphonia
//! (covering the same formats as the browser's `decodeAudioData`). Output is at
//! the file's own sample rate; the device layer resamples to the output rate.

use std::io::Cursor;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// Fully-decoded track: interleaved stereo f32 at `sample_rate`.
#[derive(Debug, Clone)]
pub struct DecodedTrack {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

impl DecodedTrack {
    pub fn frames(&self) -> usize {
        self.samples.len() / 2
    }
}

/// Decode `bytes` (a complete encoded file) to interleaved stereo. Mono is
/// duplicated to both channels; >2 channels are truncated to the first two.
pub fn decode_bytes(bytes: Vec<u8>) -> Result<DecodedTrack, String> {
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    let probed = symphonia::default::get_probe()
        .format(
            &Hint::new(),
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| format!("probe failed: {e}"))?;
    let mut format = probed.format;

    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "no decodable audio track".to_string())?;
    let track_id = track.id;
    let sample_rate = track
        .codec_params
        .sample_rate
        .ok_or_else(|| "unknown sample rate".to_string())?;

    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("no decoder: {e}"))?;

    let mut samples: Vec<f32> = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    while let Ok(packet) = format.next_packet() {
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                if sample_buf.is_none() {
                    sample_buf = Some(SampleBuffer::<f32>::new(
                        audio_buf.capacity() as u64,
                        *audio_buf.spec(),
                    ));
                }
                let n_ch = audio_buf.spec().channels.count();
                let sb = sample_buf.as_mut().unwrap();
                sb.copy_interleaved_ref(audio_buf);
                append_stereo(&mut samples, sb.samples(), n_ch);
            }
            Err(SymphoniaError::DecodeError(_)) => continue, // recoverable glitch
            Err(_) => break,                                 // EOF / reset / io end
        }
    }

    if samples.is_empty() {
        return Err("decoded to zero samples".to_string());
    }
    Ok(DecodedTrack {
        samples,
        sample_rate,
    })
}

/// Append `src` (interleaved by `n_ch`) to `out` as interleaved stereo.
fn append_stereo(out: &mut Vec<f32>, src: &[f32], n_ch: usize) {
    if n_ch == 0 {
        return;
    }
    for frame in src.chunks_exact(n_ch) {
        let l = frame[0];
        let r = if n_ch >= 2 { frame[1] } else { l };
        out.push(l);
        out.push(r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal PCM WAV: `frames` of a low-amplitude ramp, so it's decodable
    /// and not all-silent.
    fn make_wav(frames: u32, rate: u32, channels: u16) -> Vec<u8> {
        let data_len = frames * channels as u32 * 2;
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data_len).to_le_bytes());
        b.extend_from_slice(b"WAVE");
        b.extend_from_slice(b"fmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&1u16.to_le_bytes()); // PCM
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&rate.to_le_bytes());
        b.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        b.extend_from_slice(&(channels * 2).to_le_bytes());
        b.extend_from_slice(&16u16.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&data_len.to_le_bytes());
        for i in 0..frames {
            let v = ((i % 200) as i16) * 100 - 10_000;
            for _ in 0..channels {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        b
    }

    #[test]
    fn decodes_mono_wav_to_stereo() {
        let track = decode_bytes(make_wav(1000, 8000, 1)).unwrap();
        assert_eq!(track.sample_rate, 8000);
        assert_eq!(track.frames(), 1000);
        // mono duplicated: L == R in every frame
        assert!(track.samples.chunks_exact(2).all(|f| f[0] == f[1]));
    }

    #[test]
    fn decodes_stereo_wav() {
        let track = decode_bytes(make_wav(500, 44_100, 2)).unwrap();
        assert_eq!(track.sample_rate, 44_100);
        assert_eq!(track.frames(), 500);
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode_bytes(vec![0u8; 32]).is_err());
    }
}
