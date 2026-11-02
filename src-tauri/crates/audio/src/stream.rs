//! One track's PCM around the playhead: a feeder thread reads chunks from a [`PcmSource`] and
//! publishes them for the output callback, which never blocks on them.

use crate::mixer::{self, ReadFrames};
use arc_swap::{ArcSwap, Guard};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock, Weak};
use std::thread::Thread;
use std::time::{Duration, Instant};

pub const BYTES_PER_FRAME: u64 = 4;
const CHUNK_FRAMES: u64 = 1 << 16;
const CHUNKS_AHEAD: u64 = 6;
const CHUNKS_BEHIND: u64 = 1;
const NO_OUTPUT_RATE: u32 = 48_000;
const IDLE_POLL: Duration = Duration::from_millis(20);
const FAILED_READ_RETRY: Duration = Duration::from_secs(1);
const RETIRED_FOR: Duration = Duration::from_secs(1);

#[derive(Clone, Copy)]
pub struct PcmInfo {
    pub frames: u64,
    pub rate: u32,
}

/// Headerless 16-bit little-endian stereo, read from the feeder thread alone.
pub trait PcmSource: Send + 'static {
    /// Asks for the audio at `rate`; answers with what it has, which may be at another rate.
    fn open(&mut self, rate: u32) -> Result<PcmInfo, String>;
    /// Fills `bytes` from `start_frame`, at the rate `open` answered.
    fn read(&mut self, start_frame: u64, bytes: &mut [u8]) -> Result<(), String>;
}

/// Where the track is wanted, read from the feeder thread.
pub trait Playhead: Send + Sync + 'static {
    fn frame(&self) -> u64;
    /// 0 while there's no output.
    fn output_rate(&self) -> u32;
}

/// Holds what the output callback may still be reading, so it's never the one to free it:
/// a free that size can stall the audio thread.
pub(crate) struct Retired<T> {
    held: VecDeque<(Instant, Arc<T>)>,
}

impl<T> Retired<T> {
    pub(crate) fn new() -> Self {
        Self { held: VecDeque::new() }
    }

    pub(crate) fn retire(&mut self, old: Arc<T>) {
        self.held.push_back((Instant::now(), old));
        while self.held.front().is_some_and(|(at, _)| at.elapsed() > RETIRED_FOR) {
            self.held.pop_front();
        }
    }
}

struct PcmChunk {
    first_frame: u64,
    samples: Vec<f32>,
}

pub struct PcmWindow {
    chunks: Vec<Arc<PcmChunk>>,
    total_frames: u64,
}

impl PcmWindow {
    /// Nothing yet, in audio of unknown length.
    fn empty() -> Self {
        Self { chunks: Vec::new(), total_frames: u64::MAX }
    }

    fn holds(&self, first_frame: u64) -> bool {
        self.chunks.iter().any(|c| c.first_frame == first_frame)
    }

    /// Whether the audio on both sides of `frame` is in, or there's none to wait for.
    pub fn ready_around(&self, frame: u64) -> bool {
        let chunk = frame / CHUNK_FRAMES;
        [chunk.checked_sub(1), Some(chunk), Some(chunk + 1)]
            .into_iter()
            .flatten()
            .map(|c| c * CHUNK_FRAMES)
            .all(|first_frame| first_frame >= self.total_frames || self.holds(first_frame))
    }
}

impl ReadFrames for PcmWindow {
    fn read_frames(&self, out: &mut [f32], start_frame: usize) {
        mixer::silence(out);
        let start = start_frame as u64;
        let end = start + out.len() as u64 / 2;
        for chunk in &self.chunks {
            let chunk_end = chunk.first_frame + chunk.samples.len() as u64 / 2;
            let from = start.max(chunk.first_frame);
            let to = end.min(chunk_end);
            if from >= to {
                continue;
            }
            let copied = ((to - from) * 2) as usize;
            let in_chunk = ((from - chunk.first_frame) * 2) as usize;
            let in_out = ((from - start) * 2) as usize;
            out[in_out..in_out + copied].copy_from_slice(&chunk.samples[in_chunk..in_chunk + copied]);
        }
    }
}

pub struct PcmStream {
    window: ArcSwap<PcmWindow>,
    in_mix: AtomicBool,
    stopped: AtomicBool,
    feeder: OnceLock<Thread>,
}

impl PcmStream {
    pub fn window(&self) -> Guard<Arc<PcmWindow>> {
        self.window.load()
    }

    /// From now on it follows the playhead, instead of holding the song's opening ready.
    pub fn join_mix(&self) {
        self.in_mix.store(true, Ordering::Relaxed);
    }

    /// The playhead jumped: have the feeder look now, not at its next poll.
    pub fn wake(&self) {
        if let Some(feeder) = self.feeder.get() {
            feeder.unpark();
        }
    }

    /// Ends the feeder, while what it read stays readable for whoever still holds the stream.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
        self.wake();
    }
}

/// Returns once the opening of the audio is in hand.
pub fn open_stream(source: Box<dyn PcmSource>, playhead: Weak<dyn Playhead>) -> Result<Arc<PcmStream>, String> {
    let stream = Arc::new(PcmStream {
        window: ArcSwap::from_pointee(PcmWindow::empty()),
        in_mix: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        feeder: OnceLock::new(),
    });
    let (ready, opened) = mpsc::channel();
    let feeder = Feeder {
        stream: Arc::downgrade(&stream),
        source,
        playhead,
        opened: None,
        bytes: Vec::new(),
        retired: Retired::new(),
        ready: Some(ready),
    };
    let thread = std::thread::Builder::new()
        .name("utai-pcm".into())
        .spawn(move || feeder.run())
        .map_err(|e| e.to_string())?;
    let _ = stream.feeder.set(thread.thread().clone());
    opened.recv().map_err(|e| e.to_string())??;
    Ok(stream)
}

#[derive(Clone, Copy)]
struct OpenedSource {
    info: PcmInfo,
    output_rate: u32,
}

impl OpenedSource {
    fn output_frames(&self) -> u64 {
        if self.info.rate == self.output_rate {
            return self.info.frames;
        }
        (self.info.frames as u128 * self.output_rate as u128 / self.info.rate as u128) as u64
    }
}

struct Feeder {
    stream: Weak<PcmStream>,
    source: Box<dyn PcmSource>,
    playhead: Weak<dyn Playhead>,
    opened: Option<OpenedSource>,
    bytes: Vec<u8>,
    retired: Retired<PcmWindow>,
    ready: Option<Sender<Result<(), String>>>,
}

impl Feeder {
    fn run(mut self) {
        // Weak both ways: the engine owns the streams, so holding either would keep it all alive.
        while let (Some(stream), Some(playhead)) = (self.stream.upgrade(), self.playhead.upgrade()) {
            if stream.stopped.load(Ordering::Relaxed) {
                return;
            }
            let wait = match self.step(&stream, playhead.as_ref()) {
                Ok(true) => None,
                Ok(false) => Some(IDLE_POLL),
                Err(err) => {
                    let Some(ready) = self.ready.take() else {
                        log::warn!("[utai-audio] PCM read failed: {err}");
                        drop(stream);
                        drop(playhead);
                        std::thread::park_timeout(FAILED_READ_RETRY);
                        continue;
                    };
                    let _ = ready.send(Err(err));
                    return;
                }
            };
            drop(stream);
            drop(playhead);
            if let Some(wait) = wait {
                std::thread::park_timeout(wait);
            }
        }
    }

    /// Whether it read anything.
    fn step(&mut self, stream: &PcmStream, playhead: &dyn Playhead) -> Result<bool, String> {
        let output_rate = match playhead.output_rate() {
            0 => NO_OUTPUT_RATE,
            rate => rate,
        };
        let opened = match self.opened {
            Some(opened) if opened.output_rate == output_rate => opened,
            _ => {
                self.publish(stream, PcmWindow::empty());
                let opened = OpenedSource { info: self.source.open(output_rate)?, output_rate };
                self.opened = Some(opened);
                opened
            }
        };
        let frame = if stream.in_mix.load(Ordering::Relaxed) { playhead.frame() } else { 0 };
        let total_frames = opened.output_frames();
        let playhead_chunk = frame / CHUNK_FRAMES;
        let Some(first_frame) = next_missing(&stream.window(), playhead_chunk, total_frames) else {
            if let Some(ready) = self.ready.take() {
                let _ = ready.send(Ok(()));
            }
            return Ok(false);
        };
        let chunk = self.read_chunk(opened, first_frame, total_frames)?;

        let oldest = playhead_chunk.saturating_sub(CHUNKS_BEHIND) * CHUNK_FRAMES;
        let newest = (playhead_chunk + CHUNKS_AHEAD) * CHUNK_FRAMES;
        let mut chunks: Vec<Arc<PcmChunk>> = stream
            .window()
            .chunks
            .iter()
            .filter(|c| c.first_frame >= oldest && c.first_frame <= newest)
            .cloned()
            .collect();
        chunks.push(Arc::new(chunk));
        self.publish(stream, PcmWindow { chunks, total_frames });
        if let Some(ready) = self.ready.take() {
            let _ = ready.send(Ok(()));
        }
        Ok(true)
    }

    fn publish(&mut self, stream: &PcmStream, window: PcmWindow) {
        self.retired.retire(stream.window.swap(Arc::new(window)));
    }

    fn read_chunk(&mut self, opened: OpenedSource, first_frame: u64, total_frames: u64) -> Result<PcmChunk, String> {
        let frames = CHUNK_FRAMES.min(total_frames - first_frame);
        if opened.info.rate == opened.output_rate {
            self.bytes.resize((frames * BYTES_PER_FRAME) as usize, 0);
            self.source.read(first_frame, &mut self.bytes)?;
            let samples = self.bytes.chunks_exact(2).map(sample).collect();
            return Ok(PcmChunk { first_frame, samples });
        }
        // Interpolated from absolute positions, so chunks meet without a seam.
        let ratio = opened.info.rate as f64 / opened.output_rate as f64;
        let source_first = (first_frame as f64 * ratio).floor() as u64;
        let source_end = (((first_frame + frames) as f64 * ratio).ceil() as u64 + 1).min(opened.info.frames);
        self.bytes.resize((source_end.saturating_sub(source_first) * BYTES_PER_FRAME) as usize, 0);
        self.source.read(source_first, &mut self.bytes)?;
        let held = self.bytes.len() / BYTES_PER_FRAME as usize;
        let at = |bytes: &[u8], frame: usize, channel: usize| {
            if frame >= held {
                return 0.0;
            }
            let offset = frame * BYTES_PER_FRAME as usize + channel * 2;
            sample(&bytes[offset..offset + 2])
        };
        let mut samples = Vec::with_capacity(frames as usize * 2);
        for i in 0..frames {
            let position = (first_frame + i) as f64 * ratio - source_first as f64;
            let whole = position as usize;
            let fraction = (position - whole as f64) as f32;
            for channel in 0..2 {
                let here = at(&self.bytes, whole, channel);
                samples.push(here + (at(&self.bytes, whole + 1, channel) - here) * fraction);
            }
        }
        Ok(PcmChunk { first_frame, samples })
    }
}

fn sample(bytes: &[u8]) -> f32 {
    i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0
}

/// The playhead's chunk first, then the one before it for a stretcher's pre-roll, then ahead.
fn next_missing(window: &PcmWindow, playhead_chunk: u64, total_frames: u64) -> Option<u64> {
    let behind = playhead_chunk.checked_sub(CHUNKS_BEHIND);
    let ahead = (1..=CHUNKS_AHEAD).map(|n| Some(playhead_chunk + n));
    std::iter::once(Some(playhead_chunk))
        .chain(std::iter::once(behind))
        .chain(ahead)
        .flatten()
        .map(|chunk| chunk * CHUNK_FRAMES)
        .find(|&first_frame| first_frame < total_frames && !window.holds(first_frame))
}

/// A temp file of PCM the frontend decoded, deleted with this, or now if it can't be used.
pub struct TempFilePcm {
    path: PathBuf,
    rate: u32,
    file: File,
}

impl TempFilePcm {
    pub fn new(path: PathBuf, rate: u32) -> Result<Self, String> {
        let opened = if rate == 0 {
            Err("PCM has no sample rate".to_string())
        } else {
            File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))
        };
        match opened {
            Ok(file) => Ok(Self { path, rate, file }),
            Err(err) => {
                let _ = std::fs::remove_file(&path);
                Err(err)
            }
        }
    }
}

impl PcmSource for TempFilePcm {
    fn open(&mut self, _rate: u32) -> Result<PcmInfo, String> {
        let bytes = self.file.metadata().map_err(|e| e.to_string())?.len();
        Ok(PcmInfo { frames: bytes / BYTES_PER_FRAME, rate: self.rate })
    }

    fn read(&mut self, start_frame: u64, bytes: &mut [u8]) -> Result<(), String> {
        self.file
            .seek(SeekFrom::Start(start_frame * BYTES_PER_FRAME))
            .and_then(|_| self.file.read_exact(bytes))
            .map_err(|e| e.to_string())
    }
}

impl Drop for TempFilePcm {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, AtomicU64};
    use std::sync::Mutex;

    const RATE: u32 = 48_000;
    const SONG: u64 = CHUNK_FRAMES * 40;

    fn left_at(frame: u64) -> i16 {
        (frame & 0x7fff) as i16
    }

    fn right_at(frame: u64) -> i16 {
        -1 - (frame / CHUNK_FRAMES) as i16
    }

    fn scaled(value: i16) -> f32 {
        value as f32 / 32768.0
    }

    struct FakeHead {
        frame: AtomicU64,
        rate: AtomicU32,
    }

    impl Playhead for FakeHead {
        fn frame(&self) -> u64 {
            self.frame.load(Ordering::Relaxed)
        }
        fn output_rate(&self) -> u32 {
            self.rate.load(Ordering::Relaxed)
        }
    }

    #[derive(Default)]
    struct Script {
        opens: Vec<u32>,
        fail_reads: u32,
        fail_open: bool,
        dropped: bool,
    }

    struct FakeSource {
        frames: u64,
        /// None serves the rate asked for.
        own_rate: Option<u32>,
        script: Arc<Mutex<Script>>,
    }

    impl PcmSource for FakeSource {
        fn open(&mut self, rate: u32) -> Result<PcmInfo, String> {
            let mut script = self.script.lock().unwrap();
            script.opens.push(rate);
            if script.fail_open {
                return Err("no such audio".to_string());
            }
            Ok(PcmInfo { frames: self.frames, rate: self.own_rate.unwrap_or(rate) })
        }

        fn read(&mut self, start_frame: u64, bytes: &mut [u8]) -> Result<(), String> {
            let mut script = self.script.lock().unwrap();
            if script.fail_reads > 0 {
                script.fail_reads -= 1;
                return Err("backend went away".to_string());
            }
            for (i, frame) in bytes.chunks_exact_mut(BYTES_PER_FRAME as usize).enumerate() {
                let at = start_frame + i as u64;
                frame[..2].copy_from_slice(&left_at(at).to_le_bytes());
                frame[2..].copy_from_slice(&right_at(at).to_le_bytes());
            }
            Ok(())
        }
    }

    impl Drop for FakeSource {
        fn drop(&mut self) {
            self.script.lock().unwrap().dropped = true;
        }
    }

    struct Setup {
        head: Arc<FakeHead>,
        script: Arc<Mutex<Script>>,
    }

    impl Setup {
        fn open(&self, source: Box<FakeSource>) -> Result<Arc<PcmStream>, String> {
            let head: Arc<dyn Playhead> = self.head.clone();
            open_stream(source, Arc::downgrade(&head))
        }
    }

    fn setup(frames: u64, own_rate: Option<u32>) -> (Setup, Box<FakeSource>) {
        let script = Arc::new(Mutex::new(Script::default()));
        let head = Arc::new(FakeHead { frame: AtomicU64::new(0), rate: AtomicU32::new(RATE) });
        (Setup { head, script: script.clone() }, Box::new(FakeSource { frames, own_rate, script }))
    }

    fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn held_chunks(stream: &PcmStream) -> Vec<u64> {
        let mut held: Vec<u64> = stream.window().chunks.iter().map(|c| c.first_frame / CHUNK_FRAMES).collect();
        held.sort_unstable();
        held
    }

    fn heard(stream: &PcmStream, frame: u64) -> (f32, f32) {
        let mut out = [9.0f32; 2];
        stream.window().read_frames(&mut out, frame as usize);
        (out[0], out[1])
    }

    fn expected(frame: u64) -> (f32, f32) {
        (scaled(left_at(frame)), scaled(right_at(frame)))
    }

    #[test]
    fn a_new_stream_holds_the_opening_of_the_song_however_far_on_the_playhead_is() {
        let (s, source) = setup(SONG, None);
        s.head.frame.store(CHUNK_FRAMES * 20, Ordering::Relaxed);
        let stream = s.open(source).unwrap();
        assert_eq!(heard(&stream, 100), expected(100));
        wait_for("the window to fill", || held_chunks(&stream).len() == 7);
        assert_eq!(held_chunks(&stream), vec![0, 1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn in_the_mix_it_follows_the_playhead_and_holds_no_more_than_its_window() {
        let (s, source) = setup(SONG, None);
        let stream = s.open(source).unwrap();
        stream.join_mix();
        wait_for("the window to fill", || held_chunks(&stream).len() == 7);

        let far = CHUNK_FRAMES * 20 + 5;
        s.head.frame.store(far, Ordering::Relaxed);
        stream.wake();
        wait_for("the window to move", || held_chunks(&stream) == vec![19, 20, 21, 22, 23, 24, 25, 26]);
        assert_eq!(heard(&stream, far), expected(far));
        assert_eq!(heard(&stream, CHUNK_FRAMES * 2), (0.0, 0.0));
    }

    #[test]
    fn a_read_crossing_a_chunk_boundary_is_seamless_and_past_the_end_is_silence() {
        let (s, source) = setup(CHUNK_FRAMES + 10, None);
        let stream = s.open(source).unwrap();
        wait_for("the second chunk", || held_chunks(&stream).len() == 2);
        let mut out = vec![9.0f32; 40];
        stream.window().read_frames(&mut out, CHUNK_FRAMES as usize - 4);
        let first = CHUNK_FRAMES - 4;
        for i in 0..14 {
            assert_eq!((out[i * 2], out[i * 2 + 1]), expected(first + i as u64), "frame {i}");
        }
        assert_eq!(&out[28..], &[0.0; 12]);
    }

    #[test]
    fn it_is_ready_around_a_frame_only_with_the_chunks_on_both_sides_or_the_end_of_the_song() {
        let (s, source) = setup(CHUNK_FRAMES * 3, None);
        let stream = s.open(source).unwrap();
        wait_for("the whole song", || held_chunks(&stream).len() == 3);
        let window = stream.window();
        assert!(window.ready_around(0));
        assert!(window.ready_around(CHUNK_FRAMES * 2 + 5));
        assert!(window.ready_around(CHUNK_FRAMES * 50));
        assert!(!PcmWindow::empty().ready_around(0));

        let (s, source) = setup(SONG, None);
        let stream = s.open(source).unwrap();
        wait_for("the window to fill", || held_chunks(&stream).len() == 7);
        let window = stream.window();
        assert!(window.ready_around(CHUNK_FRAMES * 5));
        assert!(!window.ready_around(CHUNK_FRAMES * 6));
        assert!(!window.ready_around(CHUNK_FRAMES * 20));
    }

    #[test]
    fn audio_that_cannot_be_opened_fails_the_preload_and_lets_go_of_its_source() {
        let (s, source) = setup(SONG, None);
        s.script.lock().unwrap().fail_open = true;
        assert_eq!(s.open(source).err().unwrap(), "no such audio");
        wait_for("the source to be dropped", || s.script.lock().unwrap().dropped);
    }

    #[test]
    fn a_first_read_failing_fails_the_preload() {
        let (s, source) = setup(SONG, None);
        s.script.lock().unwrap().fail_reads = 1;
        assert_eq!(s.open(source).err().unwrap(), "backend went away");
    }

    #[test]
    fn a_read_failing_once_playing_is_tried_again() {
        let (s, source) = setup(SONG, None);
        let stream = s.open(source).unwrap();
        wait_for("the window to fill", || held_chunks(&stream).len() == 7);
        s.script.lock().unwrap().fail_reads = 1;
        stream.join_mix();
        let far = CHUNK_FRAMES * 20;
        s.head.frame.store(far, Ordering::Relaxed);
        wait_for("the read to succeed", || heard(&stream, far) == expected(far));
    }

    #[test]
    fn dropping_the_stream_ends_the_feeder() {
        let (s, source) = setup(SONG, None);
        let stream = s.open(source).unwrap();
        drop(stream);
        wait_for("the source to be dropped", || s.script.lock().unwrap().dropped);
    }

    #[test]
    fn stopping_ends_the_feeder_and_what_it_read_stays_readable() {
        let (s, source) = setup(SONG, None);
        let stream = s.open(source).unwrap();
        stream.stop();
        wait_for("the source to be dropped", || s.script.lock().unwrap().dropped);
        assert_eq!(heard(&stream, 100), expected(100));
    }

    #[test]
    fn dropping_the_playhead_ends_the_feeder() {
        let (s, source) = setup(SONG, None);
        let script = s.script.clone();
        let stream = s.open(source).unwrap();
        drop(s);
        wait_for("the source to be dropped", || script.lock().unwrap().dropped);
        drop(stream);
    }

    #[test]
    fn a_new_output_rate_opens_the_audio_again_at_that_rate() {
        let (s, source) = setup(SONG, None);
        let stream = s.open(source).unwrap();
        stream.join_mix();
        s.head.rate.store(96_000, Ordering::Relaxed);
        s.head.frame.store(CHUNK_FRAMES * 20, Ordering::Relaxed);
        wait_for("the source to reopen", || s.script.lock().unwrap().opens == vec![RATE, 96_000]);
        wait_for("the window to refill", || held_chunks(&stream).contains(&20));
    }

    #[test]
    fn no_output_yet_still_readies_the_song() {
        let (s, source) = setup(SONG, None);
        s.head.rate.store(0, Ordering::Relaxed);
        let stream = s.open(source).unwrap();
        assert_eq!(heard(&stream, 100), expected(100));
        assert_eq!(s.script.lock().unwrap().opens, vec![NO_OUTPUT_RATE]);
    }

    #[test]
    fn audio_at_half_the_output_rate_is_interpolated_across_chunks() {
        let (s, source) = setup(SONG / 2, Some(RATE / 2));
        let stream = s.open(source).unwrap();
        wait_for("the second chunk", || held_chunks(&stream).len() >= 2);
        for frame in [8u64, 800, CHUNK_FRAMES - 2, CHUNK_FRAMES, CHUNK_FRAMES + 2] {
            assert_eq!(heard(&stream, frame), expected(frame / 2), "even frame {frame}");
        }
        for frame in [9u64, 801, CHUNK_FRAMES - 1, CHUNK_FRAMES + 1] {
            let (before, after) = (expected((frame - 1) / 2), expected((frame + 1) / 2));
            let (left, right) = heard(&stream, frame);
            assert!((left - (before.0 + after.0) / 2.0).abs() < 1e-6, "odd frame {frame}");
            assert!((right - (before.1 + after.1) / 2.0).abs() < 1e-6, "odd frame {frame}");
        }
    }

    #[test]
    fn audio_at_twice_the_output_rate_plays_at_its_own_speed() {
        let (s, source) = setup(SONG * 2, Some(RATE * 2));
        let stream = s.open(source).unwrap();
        wait_for("the second chunk", || held_chunks(&stream).len() >= 2);
        for frame in [8u64, 801, CHUNK_FRAMES - 1, CHUNK_FRAMES, CHUNK_FRAMES + 3] {
            assert_eq!(heard(&stream, frame), expected(frame * 2), "frame {frame}");
        }
    }

    fn temp_pcm(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("utai-pcm-{name}-{}.s16", std::process::id()));
        let bytes: Vec<u8> = (0i16..100).flat_map(|n| [n, -n]).flat_map(i16::to_le_bytes).collect();
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn a_temp_file_is_read_from_any_frame_and_deleted_with_its_source() {
        let path = temp_pcm("read");
        let mut file = TempFilePcm::new(path.clone(), 44_100).unwrap();
        let info = file.open(RATE).unwrap();
        assert_eq!((info.frames, info.rate), (100, 44_100));
        let mut read = [0u8; 4];
        file.read(7, &mut read).unwrap();
        assert_eq!(read, [7, 0, 249, 255]);
        drop(file);
        assert!(!path.exists());
    }

    #[test]
    fn a_temp_file_with_no_rate_is_refused_and_deleted() {
        let path = temp_pcm("no-rate");
        assert!(TempFilePcm::new(path.clone(), 0).is_err());
        assert!(!path.exists());
    }
}
