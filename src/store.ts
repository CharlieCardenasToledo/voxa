import { create } from 'zustand';

export type Screen = 'home' | 'prepare' | 'practice' | 'live' | 'summary' | 'settings' | 'history';
export type SessionMode = 'class' | 'presentation' | 'reunion';
export type LiveState = 'idle' | 'them-speaking' | 'them-finished' | 'generating' | 'answer-ready' | 'me-speaking';
export type Turn = { id: string; speaker: 'ME' | 'THEM'; text: string; translation?: string; sourceLanguage?: string; translating?: boolean; time: string };
export type CopilotAnswer = { questionEn: string; questionEs: string; answer: string; more: string; idea: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; warning?: string };
export type PracticeItem = { question: string; answer: string };
export type CapturePhase = 'starting' | 'listening' | 'paused' | 'error' | 'stopped';
export type AudioSourceState = { level: number; active: boolean; device: string; transcription: 'offline' | 'connecting' | 'connected' | 'error'; error?: string };
export type TokenUsage = { inputTokens: number; outputTokens: number };
export type SlideScriptEntry = { scriptEn: string; pronunciation: string; scriptEs: string };
export type PresentationPhase = 'intro' | 'slides' | 'outro';

const demoAnswer: CopilotAnswer = {
  questionEn: 'Why did you choose this architecture instead of microservices?',
  questionEs: '¿Por qué eligieron esta arquitectura en lugar de microservicios?',
  answer: 'We chose this architecture because it keeps the system simpler to develop and maintain. At our current scale, microservices would add unnecessary complexity.',
  more: 'If the application grows significantly, we can separate specific components into independent services later.',
  idea: 'Mantener el sistema simple ahora y separar componentes cuando el crecimiento lo justifique.',
  confidence: 'HIGH'
};

type Store = {
  screen: Screen; previousScreen: Screen; sessionTitle: string; sessionId: string | null; practiceQuestions: PracticeItem[]; liveState: LiveState; paused: boolean; answer: CopilotAnswer | null; answerLoading: boolean; answerError: string | null; activeQuestion: string | null; questionQueue: string[]; answerCostUsd: number; liveUsage: Record<'ME' | 'THEM', TokenUsage>; turns: Turn[]; interimTranscripts: Record<'ME' | 'THEM', string>; prepared: boolean; capturePhase: CapturePhase; captureError: string | null; audioSources: Record<'ME' | 'THEM', AudioSourceState>;
  sessionMode: SessionMode; slidePages: string[]; slideScripts: SlideScriptEntry[]; introScript: SlideScriptEntry | null; outroScript: SlideScriptEntry | null; currentSlideIndex: number; presentationPhase: PresentationPhase; presentationFinished: boolean; presentationPdfBytes: Uint8Array | null; presentationMonitorIndex: number; liveElapsedSeconds: number;
  setScreen: (screen: Screen) => void; setSessionTitle: (title: string) => void; setSessionId: (id: string) => void; prepare: (title: string) => void; markPrepared: (title: string) => void; startLive: (demo?: boolean) => void; endLive: () => void; setPaused: (paused: boolean) => void; setLiveElapsedSeconds: (seconds: number) => void;
  addTurn: (turn: Turn) => void; updateTurn: (id: string, patch: Partial<Turn>) => void; setTurns: (turns: Turn[]) => void; setPracticeQuestions: (questions: PracticeItem[]) => void; setInterimTranscript: (speaker: 'ME' | 'THEM', text: string) => void; setAnswer: (answer: CopilotAnswer) => void; setAnswerText: (answer: string) => void; setAnswerLoading: (loading: boolean) => void; setAnswerError: (error: string | null) => void; setActiveQuestion: (question: string | null) => void; enqueueQuestion: (question: string) => void; removeFirstQueuedQuestion: () => void; removeQueuedQuestion: (question: string) => void; addAnswerCost: (cost: number) => void; setLiveUsage: (speaker: 'ME' | 'THEM', usage: TokenUsage) => void; clearLiveDemo: () => void; setCapture: (phase: CapturePhase, error?: string | null) => void; setAudioSource: (speaker: 'ME' | 'THEM', patch: Partial<AudioSourceState>) => void;
  setSessionMode: (mode: SessionMode) => void; setSlideDeck: (pages: string[], scripts: SlideScriptEntry[], intro: SlideScriptEntry | null, outro: SlideScriptEntry | null) => void; setCurrentSlideIndex: (index: number) => void; setPresentationFinished: (finished: boolean) => void; setPresentationPhase: (phase: PresentationPhase) => void; setPresentationPdfBytes: (bytes: Uint8Array | null) => void; setPresentationMonitorIndex: (index: number) => void;
};

export const useStore = create<Store>((set) => ({
  screen: 'home', previousScreen: 'home', sessionTitle: 'Presentación de arquitectura técnica', sessionId: null, practiceQuestions: [], liveState: 'idle', paused: false, answer: null, answerLoading: false, answerError: null, activeQuestion: null, questionQueue: [], answerCostUsd: 0, liveUsage: { ME: { inputTokens: 0, outputTokens: 0 }, THEM: { inputTokens: 0, outputTokens: 0 } }, turns: [], interimTranscripts: { ME: '', THEM: '' }, prepared: false, capturePhase: 'stopped', captureError: null,
  audioSources: {
    ME: { level: 0, active: false, device: 'Micrófono predeterminado', transcription: 'offline' },
    THEM: { level: 0, active: false, device: 'Salida de audio predeterminada', transcription: 'offline' },
  },
  sessionMode: 'class', slidePages: [], slideScripts: [], introScript: null, outroScript: null, currentSlideIndex: 0, presentationPhase: 'intro', presentationFinished: false, presentationPdfBytes: null, presentationMonitorIndex: 0, liveElapsedSeconds: 0,
  setScreen: (screen) => set((state) => (state.screen === screen ? state : { screen, previousScreen: state.screen })),
  setSessionTitle: (sessionTitle) => set({ sessionTitle }),
  setSessionId: (sessionId) => set({ sessionId }),
  prepare: (sessionTitle) => set({ sessionTitle, prepared: true, screen: 'practice' }),
  markPrepared: (sessionTitle) => set({ sessionTitle, prepared: true }),
  startLive: (demo = true) => set(demo ? { screen: 'live', liveState: 'them-speaking', paused: false, answer: demoAnswer, answerLoading: false, answerError: null, activeQuestion: demoAnswer.questionEn, questionQueue: [], answerCostUsd: 0, liveUsage: { ME: { inputTokens: 0, outputTokens: 0 }, THEM: { inputTokens: 0, outputTokens: 0 } }, turns: [{ id: 'demo-me', speaker: 'ME', text: 'Today I am going to explain the architecture we selected for the project.', translation: 'Hoy explicaré la arquitectura que seleccionamos para el proyecto.', time: '09:41' }, { id: 'demo-them', speaker: 'THEM', text: demoAnswer.questionEn, translation: demoAnswer.questionEs, time: '09:42' }], interimTranscripts: { ME: '', THEM: '' }, liveElapsedSeconds: 0 } : { screen: 'live', liveState: 'them-speaking', paused: false, answer: null, answerLoading: false, answerError: null, activeQuestion: null, questionQueue: [], answerCostUsd: 0, liveUsage: { ME: { inputTokens: 0, outputTokens: 0 }, THEM: { inputTokens: 0, outputTokens: 0 } }, turns: [], interimTranscripts: { ME: '', THEM: '' }, liveElapsedSeconds: 0 }),
  endLive: () => set((state) => ({ screen: 'summary', previousScreen: state.screen, liveState: 'idle', paused: false, presentationFinished: false })),
  setPaused: (paused) => set({ paused, liveState: paused ? 'idle' : 'them-speaking' }),
  setLiveElapsedSeconds: (liveElapsedSeconds) => set({ liveElapsedSeconds }),
  addTurn: (turn) => set((state) => ({ turns: [...state.turns, turn].slice(-200) })),
  updateTurn: (id, patch) => set((state) => ({ turns: state.turns.map(turn => turn.id === id ? { ...turn, ...patch } : turn) })),
  setTurns: (turns) => set({ turns: turns.slice(-200) }),
  setPracticeQuestions: (practiceQuestions) => set({ practiceQuestions }),
  setInterimTranscript: (speaker, text) => set((state) => ({ interimTranscripts: { ...state.interimTranscripts, [speaker]: text } })),
  setAnswer: (answer) => set({ answer, liveState: 'answer-ready' }),
  setAnswerText: (answer) => set((state) => state.answer ? { answer: { ...state.answer, answer } } : state),
  setAnswerLoading: (answerLoading) => set({ answerLoading }),
  setAnswerError: (answerError) => set({ answerError }),
  setActiveQuestion: (activeQuestion) => set({ activeQuestion }),
  enqueueQuestion: (question) => set((state) => state.questionQueue.some(item => item.toLocaleLowerCase() === question.toLocaleLowerCase()) ? state : { questionQueue: [...state.questionQueue, question].slice(-20) }),
  removeFirstQueuedQuestion: () => set((state) => ({ questionQueue: state.questionQueue.slice(1) })),
  removeQueuedQuestion: (question) => set((state) => ({ questionQueue: state.questionQueue.filter(item => item !== question) })),
  addAnswerCost: (cost) => set((state) => ({ answerCostUsd: state.answerCostUsd + cost })),
  setLiveUsage: (speaker, usage) => set((state) => ({ liveUsage: { ...state.liveUsage, [speaker]: usage } })),
  clearLiveDemo: () => set({ answer: null, answerLoading: false, answerError: null, activeQuestion: null, questionQueue: [], answerCostUsd: 0, liveUsage: { ME: { inputTokens: 0, outputTokens: 0 }, THEM: { inputTokens: 0, outputTokens: 0 } }, turns: [], interimTranscripts: { ME: '', THEM: '' }, liveState: 'them-speaking' }),
  setCapture: (capturePhase, captureError = null) => set({ capturePhase, captureError }),
  setAudioSource: (speaker, patch) => set((state) => ({ audioSources: { ...state.audioSources, [speaker]: { ...state.audioSources[speaker], ...patch } } })),
  setSessionMode: (sessionMode) => set({ sessionMode }),
  setSlideDeck: (slidePages, slideScripts, introScript, outroScript) => set({ slidePages, slideScripts, introScript, outroScript, currentSlideIndex: 0, presentationPhase: 'intro', presentationFinished: false }),
  setCurrentSlideIndex: (index) => set((state) => ({ currentSlideIndex: Math.max(0, Math.min(index, Math.max(state.slidePages.length - 1, 0))) })),
  setPresentationFinished: (presentationFinished) => set({ presentationFinished }),
  setPresentationPhase: (presentationPhase) => set({ presentationPhase }),
  setPresentationPdfBytes: (presentationPdfBytes) => set({ presentationPdfBytes }),
  setPresentationMonitorIndex: (presentationMonitorIndex) => set({ presentationMonitorIndex }),
}));
