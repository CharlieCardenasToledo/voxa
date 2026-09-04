use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::Sample;
use std::sync::{Arc, Mutex};

use crate::audio::{
    downmix, resample_linear, take_pcm_chunks, to_pcm16, VadEvent, VoiceActivityDetector,
    CHUNK_BYTES, TARGET_RATE,
};

#[derive(Debug, Clone, serde::Serialize)]
pub struct CaptureStatus {
    pub microphone: bool,
    pub loopback: bool,
    pub running: bool,
    pub error: Option<String>,
    pub microphone_name: Option<String>,
    pub loopback_name: Option<String>,
}

pub struct AudioCapture {
    _mic: cpal::Stream,
    _loopback: cpal::Stream,
    microphone_name: String,
    loopback_name: String,
}

impl AudioCapture {
    pub fn start(
        on_chunk: impl Fn(&'static str, Vec<u8>, bool) + Send + Sync + 'static,
    ) -> Result<Self, String> {
        let host = cpal::default_host();
        let microphone = host
            .default_input_device()
            .ok_or("No default microphone found")?;
        let output = host
            .default_output_device()
            .ok_or("No default output device found")?;
        let microphone_name = microphone
            .name()
            .unwrap_or_else(|_| "Default microphone".into());
        let loopback_name = output
            .name()
            .unwrap_or_else(|_| "Default system output".into());
        let mic_config = microphone
            .default_input_config()
            .map_err(|e| format!("Configuración del micrófono: {e}"))?;
        // CPAL's WASAPI backend enables loopback when an output device is opened
        // as an input stream. Its native mix format comes from the output config.
        let loop_config = output
            .default_output_config()
            .map_err(|e| format!("Configuración del audio del computador: {e}"))?;
        let mic_rate = mic_config.sample_rate().0;
        let mic_channels = mic_config.channels();
        let mic_callback = Arc::new(on_chunk);
        let mic_callback_clone = Arc::clone(&mic_callback);
        let mic = build_stream(
            microphone,
            &mic_config,
            mic_channels,
            mic_rate,
            move |samples, ended| (mic_callback_clone)("ME", samples, ended),
        )?;
        let loop_callback = Arc::clone(&mic_callback);
        let loopback = build_stream(
            output,
            &loop_config,
            loop_config.channels(),
            loop_config.sample_rate().0,
            move |samples, ended| (loop_callback)("THEM", samples, ended),
        )?;
        mic.play()
            .map_err(|e| format!("No se pudo iniciar el micrófono: {e}"))?;
        loopback
            .play()
            .map_err(|e| format!("No se pudo iniciar el audio del computador: {e}"))?;
        Ok(Self {
            _mic: mic,
            _loopback: loopback,
            microphone_name,
            loopback_name,
        })
    }

    pub fn device_names(&self) -> (String, String) {
        (self.microphone_name.clone(), self.loopback_name.clone())
    }

    pub fn set_source_enabled(&self, speaker: &str, enabled: bool) -> Result<(), String> {
        let stream = match speaker {
            "ME" => &self._mic,
            "THEM" => &self._loopback,
            _ => return Err("Fuente de audio desconocida".into()),
        };
        if enabled {
            stream.play().map_err(|error| error.to_string())
        } else {
            stream.pause().map_err(|error| error.to_string())
        }
    }
}

fn build_stream<T>(
    device: cpal::Device,
    config: &cpal::SupportedStreamConfig,
    channels: u16,
    rate: u32,
    callback: T,
) -> Result<cpal::Stream, String>
where
    T: Fn(Vec<u8>, bool) + Send + Sync + 'static,
{
    let stream_config: cpal::StreamConfig = config.clone().into();
    let err = |error| eprintln!("audio stream error: {error}");
    match config.sample_format() {
        cpal::SampleFormat::F32 => {
            build::<f32, _>(&device, &stream_config, channels, rate, callback, err)
        }
        cpal::SampleFormat::I16 => {
            build::<i16, _>(&device, &stream_config, channels, rate, callback, err)
        }
        cpal::SampleFormat::U16 => {
            build::<u16, _>(&device, &stream_config, channels, rate, callback, err)
        }
        format => Err(format!("Formato de audio no compatible: {format:?}")),
    }
}

fn build<S, F>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: u16,
    rate: u32,
    callback: F,
    err: impl Fn(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    S: cpal::SizedSample + cpal::Sample + Send + 'static,
    F: Fn(Vec<u8>, bool) + Send + Sync + 'static,
{
    let vad = Arc::new(Mutex::new(VoiceActivityDetector::default()));
    let vad_clone = Arc::clone(&vad);
    let mut pending = Vec::with_capacity(CHUNK_BYTES * 2);
    let stream = device
        .build_input_stream(
            config,
            move |data: &[S], _| {
                let samples: Vec<f32> = data
                    .iter()
                    .map(|sample| sample.to_float_sample().to_sample())
                    .collect();
                let mono = if channels > 1 {
                    downmix(&samples, channels)
                } else {
                    samples
                };
                let pcm = to_pcm16(&resample_linear(&mono, rate, TARGET_RATE));
                for chunk in take_pcm_chunks(&mut pending, &pcm) {
                    let ended = vad_clone
                        .lock()
                        .map(|mut detector| detector.observe(&chunk) == VadEvent::SpeechEnded)
                        .unwrap_or(false);
                    callback(chunk, ended);
                }
            },
            err,
            Some(std::time::Duration::from_millis(100)),
        )
        .map_err(|e| e.to_string())?;
    Ok(stream)
}

pub fn default_status() -> CaptureStatus {
    let host = cpal::default_host();
    let microphone = host.default_input_device();
    let output = host.default_output_device();
    CaptureStatus {
        microphone: microphone.is_some(),
        loopback: output.is_some(),
        running: false,
        error: None,
        microphone_name: microphone.and_then(|device| device.name().ok()),
        loopback_name: output.and_then(|device| device.name().ok()),
    }
}

pub enum CaptureCommand {
    Stop,
    SetSource {
        speaker: String,
        enabled: bool,
        reply: std::sync::mpsc::Sender<Result<(), String>>,
    },
}

pub type CaptureControl = std::sync::mpsc::Sender<CaptureCommand>;
