//! Small, deterministic audio primitives shared by microphone and WASAPI adapters.
//! Device capture stays platform-specific; these functions make the downstream contract stable.

pub const TARGET_RATE: u32 = 16_000;
pub const CHUNK_MS: usize = 100;
pub const CHUNK_SAMPLES: usize = TARGET_RATE as usize * CHUNK_MS / 1_000;
pub const CHUNK_BYTES: usize = CHUNK_SAMPLES * std::mem::size_of::<i16>();

pub fn take_pcm_chunks(pending: &mut Vec<u8>, incoming: &[u8]) -> Vec<Vec<u8>> {
    pending.extend_from_slice(incoming);
    let mut chunks = Vec::new();
    while pending.len() >= CHUNK_BYTES {
        let remainder = pending.split_off(CHUNK_BYTES);
        chunks.push(std::mem::replace(pending, remainder));
    }
    chunks
}
pub fn downmix(input: &[f32], channels: u16) -> Vec<f32> {
    let channel_count = channels.max(1) as usize;
    input
        .chunks_exact(channel_count)
        .map(|frame| frame.iter().sum::<f32>() / channel_count as f32)
        .collect()
}

pub fn resample_linear(input: &[f32], source_rate: u32, target_rate: u32) -> Vec<f32> {
    if input.is_empty() || source_rate == target_rate {
        return input.to_vec();
    }
    let output_len = ((input.len() as u64 * target_rate as u64) / source_rate as u64) as usize;
    (0..output_len)
        .map(|index| {
            let position = index as f32 * source_rate as f32 / target_rate as f32;
            let left = position.floor() as usize;
            let right = (left + 1).min(input.len() - 1);
            let fraction = position - left as f32;
            input[left.min(input.len() - 1)] * (1.0 - fraction) + input[right] * fraction
        })
        .collect()
}

pub fn to_pcm16(input: &[f32]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len() * 2);
    for sample in input {
        output
            .extend_from_slice(&((sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).to_le_bytes());
    }
    output
}

#[derive(Debug, Clone)]
pub struct VoiceActivityDetector {
    threshold: f32,
    silence_chunks_to_end: u32,
    speech_chunks: u32,
    silence_chunks: u32,
    active: bool,
}

impl Default for VoiceActivityDetector {
    fn default() -> Self {
        Self {
            threshold: 0.012,
            // 800 ms tolerates a short thinking/breathing pause without
            // splitting one audience question into two incomplete turns.
            silence_chunks_to_end: 8,
            speech_chunks: 0,
            silence_chunks: 0,
            active: false,
        }
    }
}

impl VoiceActivityDetector {
    pub fn observe(&mut self, pcm16: &[u8]) -> VadEvent {
        let rms = if pcm16.is_empty() {
            0.0
        } else {
            (pcm16
                .chunks_exact(2)
                .map(|bytes| {
                    let sample = i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32;
                    sample * sample
                })
                .sum::<f32>()
                / (pcm16.len() / 2) as f32)
                .sqrt()
        };
        if rms >= self.threshold {
            self.speech_chunks += 1;
            self.silence_chunks = 0;
            if !self.active {
                self.active = true;
                return VadEvent::SpeechStarted;
            }
            return VadEvent::Speech;
        }
        if self.active {
            self.silence_chunks += 1;
            if self.silence_chunks >= self.silence_chunks_to_end {
                self.active = false;
                self.speech_chunks = 0;
                self.silence_chunks = 0;
                return VadEvent::SpeechEnded;
            }
        }
        VadEvent::Silence
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum VadEvent {
    Silence,
    SpeechStarted,
    Speech,
    SpeechEnded,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stereo_is_downmixed() {
        assert_eq!(downmix(&[1.0, -1.0, 0.5, 0.5], 2), vec![0.0, 0.5]);
    }
    #[test]
    fn surround_is_downmixed_by_frame() {
        assert_eq!(downmix(&[1.0, 1.0, 1.0, 0.0, 0.0, 0.0], 3), vec![1.0, 0.0]);
    }
    #[test]
    fn resampling_reduces_samples() {
        assert_eq!(resample_linear(&[0.0, 1.0, 0.0, 1.0], 4, 2).len(), 2);
    }
    #[test]
    fn vad_ends_after_eight_silent_chunks() {
        let mut vad = VoiceActivityDetector::default();
        let voice = to_pcm16(&[0.5; 1600]);
        let silence = to_pcm16(&[0.0; 1600]);
        assert_eq!(vad.observe(&voice), VadEvent::SpeechStarted);
        for _ in 0..7 {
            assert_eq!(vad.observe(&silence), VadEvent::Silence);
        }
        assert_eq!(vad.observe(&silence), VadEvent::SpeechEnded);
    }

    #[test]
    fn pcm_is_buffered_into_exact_100ms_chunks() {
        let mut pending = Vec::new();
        assert!(take_pcm_chunks(&mut pending, &vec![1; 960]).is_empty());
        let chunks = take_pcm_chunks(&mut pending, &vec![2; CHUNK_BYTES * 2]);
        assert_eq!(chunks.len(), 2);
        assert!(chunks.iter().all(|chunk| chunk.len() == CHUNK_BYTES));
        assert_eq!(pending.len(), 960);
    }
}
