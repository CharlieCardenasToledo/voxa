import { create } from 'zustand';

export type Screen = 'prepare' | 'practice' | 'live';
export type LiveState = 'idle' | 'them-speaking' | 'them-finished' | 'generating' | 'answer-ready' | 'me-speaking';
export type Turn = { speaker: 'ME' | 'THEM'; text: string; time: string };
export type CopilotAnswer = { questionEn: string; questionEs: string; answer: string; more: string; idea: string; confidence: 'HIGH' | 'MEDIUM' | 'LOW'; warning?: string };
export type CapturePhase = 'starting' | 'listening' | 'paused' | 'error' | 'stopped';
export type AudioSourceState = { level: number; active: boolean; device: string; transcription: 'offline' | 'connecting' | 'connected' | 'error'; error?: string };

const demoAnswer: CopilotAnswer = {
  questionEn: 'Why did you choose this architecture instead of microservices?',
  questionEs: '¿Por qué eligieron esta arquitectura en lugar de microservicios?',
  answer: 'We chose this architecture because it keeps the system simpler to develop and maintain. At our current scale, microservices would add unnecessary complexity.',
  more: 'If the application grows significantly, we can separate specific components into independent services later.',
  idea: 'Mantener el sistema simple ahora y separar componentes cuando el crecimiento lo justifique.',
  confidence: 'HIGH'
};

type Store = {
  screen: Screen; sessionTitle: string; sessionId: string | null; liveState: LiveState; paused: boolean; answer: CopilotAnswer | null; turns: Turn[]; prepared: boolean; capturePhase: CapturePhase; captureError: string | null; audioSources: Record<'ME' | 'THEM', AudioSourceState>;
  setScreen: (screen: Screen) => void; setSessionTitle: (title: string) => void; setSessionId: (id: string) => void; prepare: (title: string) => void; startLive: (demo?: boolean) => void; endLive: () => void; setPaused: (paused: boolean) => void;
  addTurn: (turn: Turn) => void; setAnswer: (answer: CopilotAnswer) => void; clearLiveDemo: () => void; cycleAnswer: (kind: 'shorter' | 'more' | 'alternative') => void; setCapture: (phase: CapturePhase, error?: string | null) => void; setAudioSource: (speaker: 'ME' | 'THEM', patch: Partial<AudioSourceState>) => void;
};

export const useStore = create<Store>((set) => ({
  screen: 'prepare', sessionTitle: 'Technical Architecture Presentation', sessionId: null, liveState: 'idle', paused: false, answer: null, turns: [], prepared: false, capturePhase: 'stopped', captureError: null,
  audioSources: {
    ME: { level: 0, active: false, device: 'Default microphone', transcription: 'offline' },
    THEM: { level: 0, active: false, device: 'Default system output', transcription: 'offline' },
  },
  setScreen: (screen) => set({ screen }),
  setSessionTitle: (sessionTitle) => set({ sessionTitle }),
  setSessionId: (sessionId) => set({ sessionId }),
  prepare: (sessionTitle) => set({ sessionTitle, prepared: true, screen: 'practice' }),
  startLive: (demo = true) => set(demo ? { screen: 'live', liveState: 'them-speaking', paused: false, answer: demoAnswer, turns: [{ speaker: 'ME', text: 'Today I am going to explain the architecture we selected for the project.', time: '09:41' }, { speaker: 'THEM', text: demoAnswer.questionEn, time: '09:42' }] } : { screen: 'live', liveState: 'them-speaking', paused: false, answer: null, turns: [] }),
  endLive: () => set({ screen: 'practice', liveState: 'idle', paused: false }),
  setPaused: (paused) => set({ paused, liveState: paused ? 'idle' : 'them-speaking' }),
  addTurn: (turn) => set((state) => ({ turns: [...state.turns, turn] })),
  setAnswer: (answer) => set({ answer, liveState: 'answer-ready' }),
  clearLiveDemo: () => set({ answer: null, turns: [], liveState: 'them-speaking' }),
  setCapture: (capturePhase, captureError = null) => set({ capturePhase, captureError }),
  setAudioSource: (speaker, patch) => set((state) => ({ audioSources: { ...state.audioSources, [speaker]: { ...state.audioSources[speaker], ...patch } } })),
  cycleAnswer: (kind) => set((state) => {
    if (!state.answer) return state;
    if (kind === 'more') return { answer: { ...state.answer, answer: `${state.answer.answer} ${state.answer.more}` } };
    if (kind === 'shorter') return { answer: { ...state.answer, answer: 'We chose it because it is simpler to develop and maintain at our current scale.' } };
    return { answer: { ...state.answer, answer: 'Our choice keeps the system simple now, while leaving room to split components as the application grows.' } };
  })
}));
