import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type SystemCheck = { microphone: boolean; loopback: boolean; internet: boolean; apiConfigured: boolean };

export const isNativeRuntime = () => typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
const isTauri = isNativeRuntime;

export async function checkSystem(): Promise<SystemCheck> {
  if (!isTauri()) return { microphone: true, loopback: true, internet: true, apiConfigured: false };
  return invoke<SystemCheck>('check_system');
}

export async function prepareNativeSession(title: string): Promise<string> {
  if (!isTauri()) return `mock-session-${Date.now()}`;
  return invoke<string>('prepare_session', { title });
}

export type DocumentContext = { text: string; vocabulary: string[]; kind: string };

export async function extractDocument(fileName: string, bytes: Uint8Array): Promise<DocumentContext> {
  if (!isTauri()) return { text: `Mock presentation context for ${fileName}`, vocabulary: [], kind: fileName.toLowerCase().endsWith('.pptx') ? 'PPTX' : 'PDF' };
  return invoke<DocumentContext>('extract_document', { fileName, bytes: Array.from(bytes) });
}

export async function startNativeSession(sessionId: string): Promise<void> {
  if (isTauri()) await invoke('start_live_session', { sessionId });
}

export async function stopNativeSession(): Promise<void> {
  if (isTauri()) await invoke('stop_live_session');
}

export type CaptureStatus = { microphone: boolean; loopback: boolean; running: boolean; error: string | null; microphone_name: string | null; loopback_name: string | null };
export type AudioLevel = { speaker: 'ME' | 'THEM'; rms: number; peak: number; active: boolean };
export type TranscriptionStatus = { speaker: 'ME' | 'THEM'; state?: 'connected'; error?: string };

export async function startAudioCapture(): Promise<CaptureStatus> {
  if (!isTauri()) return { microphone: true, loopback: true, running: false, error: null, microphone_name: 'Browser microphone', loopback_name: 'Browser audio' };
  return invoke('start_audio_capture');
}

export async function stopAudioCapture(): Promise<void> {
  if (isTauri()) await invoke('stop_audio_capture');
}

export type NativeTranscript = { speaker: 'ME' | 'THEM'; text: string; interim: boolean };

export async function onNativeTranscript(callback: (transcript: NativeTranscript) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const unlisten = await listen<NativeTranscript>('transcript', event => callback(event.payload));
  return unlisten;
}

export async function onAudioLevel(callback: (level: AudioLevel) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  return listen<AudioLevel>('audio-level', event => callback(event.payload));
}

export async function onTranscriptionStatus(callback: (status: TranscriptionStatus) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const cleanStatus = await listen<TranscriptionStatus>('transcription-status', event => callback(event.payload));
  const cleanError = await listen<TranscriptionStatus>('transcription-error', event => callback(event.payload));
  return () => { cleanStatus(); cleanError(); };
}

export async function saveSession(session: { id: string; title: string; role: string; audience: string; level: string; important_facts: string; forbidden_claims: string; context: string }): Promise<void> {
  if (isTauri()) await invoke('save_session', { session });
}

export async function hasGeminiApiKey(): Promise<boolean> {
  if (!isTauri()) return false;
  return invoke<boolean>('has_gemini_api_key');
}

export async function setGeminiApiKey(key: string): Promise<void> {
  if (isTauri()) await invoke('set_gemini_api_key', { key });
}

export async function validateGeminiApiKey(): Promise<void> {
  if (isTauri()) await invoke('validate_gemini_api_key');
}

export type GeminiHealthCheck = { id: string; label: string; ok: boolean; message: string; latencyMs: number };
export type GeminiHealthReport = { overallOk: boolean; checks: GeminiHealthCheck[] };

export async function checkGeminiHealth(): Promise<GeminiHealthReport> {
  if (!isTauri()) return { overallOk: false, checks: [{ id: 'browser', label: 'Desktop app required', ok: false, message: 'Gemini health checks only run inside the Tauri app.', latencyMs: 0 }] };
  return invoke<GeminiHealthReport>('gemini_health');
}

export type NativeCopilotAnswer = { question_en: string; question_es: string; answer_b2: string; extension_b2: string; key_idea_es: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; warning: string | null };

export async function generateCopilotAnswer(question: string, knowledge: string, conversation: string): Promise<NativeCopilotAnswer | null> {
  if (!isTauri()) return null;
  return invoke<NativeCopilotAnswer>('generate_copilot_answer', { request: { question, knowledge, conversation } });
}
