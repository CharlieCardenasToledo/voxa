import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type SystemCheck = { microphone: boolean; loopback: boolean; internet: boolean; apiConfigured: boolean };

export const isNativeRuntime = () => typeof window !== 'undefined' && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
const isTauri = isNativeRuntime;

export async function checkSystem(): Promise<SystemCheck> {
  if (!isTauri()) return { microphone: true, loopback: true, internet: true, apiConfigured: false };
  return invoke<SystemCheck>('check_system');
}

export type PrepareSessionRequest = { title: string; role: string; audience: string; level: string; responseLength: string; importantFacts: string; forbiddenClaims: string; context: string; vocabulary: string };
export type PracticeQuestion = { question: string; answer: string };
export type PreparedSession = { id: string; questions: PracticeQuestion[] };
export type SavedSession = { id: string; title: string; role: string; audience: string; level: string; important_facts: string; forbidden_claims: string; context: string; response_length: string; vocabulary: string[]; questions: PracticeQuestion[] };

export async function prepareNativeSession(request: PrepareSessionRequest): Promise<PreparedSession> {
  if (!isTauri()) return { id: `mock-session-${Date.now()}`, questions: [] };
  return invoke<PreparedSession>('prepare_session', { request });
}

export type DocumentContext = { text: string; vocabulary: string[]; kind: string; extraction_method: 'local' | 'gemini_document_ocr'; ocr_used: boolean; warning: string | null; model_used: string | null; input_tokens: number; output_tokens: number };

export async function extractDocument(fileName: string, bytes: Uint8Array): Promise<DocumentContext> {
  if (!isTauri()) return { text: `Mock presentation context for ${fileName}`, vocabulary: [], kind: fileName.toLowerCase().endsWith('.pptx') ? 'PPTX' : 'PDF', extraction_method: 'local', ocr_used: false, warning: null, model_used: null, input_tokens: 0, output_tokens: 0 };
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
export type UsageUpdate = { speaker: 'ME' | 'THEM'; inputTokens: number; outputTokens: number; totalTokens: number };

export async function startAudioCapture(): Promise<CaptureStatus> {
  if (!isTauri()) return { microphone: true, loopback: true, running: false, error: null, microphone_name: 'Browser microphone', loopback_name: 'Browser audio' };
  return invoke('start_audio_capture');
}

export async function stopAudioCapture(): Promise<void> {
  if (isTauri()) await invoke('stop_audio_capture');
}

export async function setAudioSourceEnabled(speaker: 'ME' | 'THEM', enabled: boolean): Promise<void> {
  if (isTauri()) await invoke('set_audio_source_enabled', { speaker, enabled });
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

export async function onUsageUpdate(callback: (usage: UsageUpdate) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  return listen<UsageUpdate>('usage-update', event => callback(event.payload));
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

export async function loadSessions(): Promise<SavedSession[]> {
  if (!isTauri()) return [];
  return invoke<SavedSession[]>('load_sessions');
}

export async function restoreSession(id: string): Promise<PreparedSession> {
  if (!isTauri()) return { id, questions: [] };
  return invoke<PreparedSession>('restore_session', { id });
}

export async function deleteSession(id: string): Promise<void> {
  if (isTauri()) await invoke('delete_session', { id });
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

export type NativeCopilotAnswer = { question_en: string; question_es: string; answer_b2: string; extension_b2: string; key_idea_es: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; warning: string | null; model_used: string; input_tokens: number; output_tokens: number; thought_tokens: number };
export type TranscriptAnalysis = { source_language: string; target_language: string; translation: string; intent: 'QUESTION' | 'REQUEST' | 'STATEMENT' | 'NOISE'; normalized_question: string | null; complete: boolean; model_used: string; input_tokens: number; output_tokens: number; thought_tokens: number };
export type AnswerVariant = { answer: string; model_used: string; input_tokens: number; output_tokens: number; thought_tokens: number };

export async function analyzeTranscript(text: string, speaker: 'ME' | 'THEM', conversation: string): Promise<TranscriptAnalysis | null> {
  if (!isTauri()) return null;
  return invoke<TranscriptAnalysis>('analyze_transcript', { request: { text, speaker, conversation } });
}

export async function generateAnswerVariant(kind: 'shorter' | 'more' | 'alternative', question: string, currentAnswer: string, conversation: string): Promise<AnswerVariant | null> {
  if (!isTauri()) return null;
  return invoke<AnswerVariant>('generate_answer_variant', { request: { kind, question, currentAnswer, conversation } });
}

export async function generateCopilotAnswer(question: string, knowledge: string, conversation: string): Promise<NativeCopilotAnswer | null> {
  if (!isTauri()) return null;
  return invoke<NativeCopilotAnswer>('generate_copilot_answer', { request: { question, knowledge, conversation } });
}
