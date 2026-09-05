import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  Activity, AlertTriangle, AlignLeft, ArrowDownToLine, ArrowRight, ArrowUpFromLine, AudioLines,
  BarChart3, Brain, Captions, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  CircleCheck, CircleHelp, EyeOff, FileText, FileUp, FolderClock, FolderOpen, GraduationCap,
  Home as HomeIcon, KeyRound, Lock, MessagesSquare, Mic, Minimize2, Monitor as MonitorIcon,
  MonitorCheck, MonitorUp, MoreHorizontal, Pause, Play, Presentation as PresentationIcon,
  Radio, RefreshCw, RotateCcw, Search, Settings as SettingsIcon, ShieldCheck, Sparkles, Timer,
  Upload, Users, Volume2, Wallet, X,
} from 'lucide-react';
import { useStore, type AudioSourceState, type PresentationPhase, type Screen, type SessionMode, type SlideScriptEntry, type Turn } from './store';
import { analyzeTranscript, checkGeminiHealth, checkSystem, closePresenterWindow, deleteSession, extractDocument, generateAnswerVariant, generateCopilotAnswer, generateSlideScripts, getAppInfo, getUsageStats, getUserProfile, identifyMonitors, isNativeRuntime, listAudioDevices, listMonitors, loadPresentationPdf, loadSessions, onAudioDeviceChanged, onAudioLevel, onNativeTranscript, onPresenterClosed, onTranscriptionStatus, onUsageUpdate, openPresenterWindow, prepareNativeSession, resetUsageStats, restoreSession, savePresentationDeck, savePresentationPdf, saveUserProfile, setAudioSourceEnabled, setGeminiApiKey, setPresentationPdf, setSlideIndex, startAudioCapture, startNativeSession, stopAudioCapture, stopNativeSession, validateGeminiApiKey, type AppInfo, type AudioDeviceList, type CaptureStatus, type GeminiHealthReport, type MonitorInfo, type NativeCopilotAnswer, type PrepareSessionRequest, type SavedSession, type SystemCheck, type UsageStats, type UserProfile } from './services/native';
import { loadPdf, renderPdfPage } from './services/pdf';
import { looksLikeQuestion, mergeFinalTranscript } from './services/transcript';

const navItems: { id: Screen; label: string; Icon: typeof HomeIcon }[] = [
  { id: 'home', label: 'Inicio', Icon: HomeIcon },
  { id: 'prepare', label: 'Preparar sesión', Icon: Sparkles },
  { id: 'practice', label: 'Práctica', Icon: Brain },
  { id: 'live', label: 'En vivo', Icon: Radio },
  { id: 'history', label: 'Sesiones', Icon: FolderClock },
  { id: 'summary', label: 'Resumen', Icon: BarChart3 },
  { id: 'settings', label: 'Perfil y configuración', Icon: SettingsIcon },
];

const sessionModeLabel: Record<SessionMode, string> = { class: 'Clase', presentation: 'Presentación', reunion: 'Reunión' };
const sessionModeIcon: Record<SessionMode, typeof GraduationCap> = { class: GraduationCap, presentation: PresentationIcon, reunion: Users };
const tone: Record<SessionMode, string> = { class: 'bg-blue-50 text-blue-700', presentation: 'bg-violet-50 text-violet-700', reunion: 'bg-emerald-50 text-emerald-700' };

// Every saved session id is "session-<slug>-<unix-seconds>" (see prepare_session
// in lib.rs), so the trailing numeric segment doubles as a creation date
// without needing a dedicated timestamp field on the record.
function idTimestamp(id: string): number {
  const match = id.match(/-(\d{9,})$/);
  return match ? Number(match[1]) : 0;
}

function sessionDateLabel(id: string): string {
  const seconds = idTimestamp(id);
  if (!seconds) return '—';
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('es-EC', { day: '2-digit', month: 'short', year: 'numeric' });
}

function byRecency(a: SavedSession, b: SavedSession): number {
  return idTimestamp(b.id) - idTimestamp(a.id);
}

function formatHms(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Restores a saved session into the store (session id, practice questions,
 * transcript, mode, and - for presentations - the slide deck and PDF) and
 * navigates into it. Shared by Historial and Inicio's "sesiones recientes"
 * preview, which don't carry Preparar's local form state.
 */
async function applyRestoredSession(session: SavedSession): Promise<{ warning?: string }> {
  const restored = await restoreSession(session.id);
  const store = useStore.getState();
  store.setSessionId(restored.id);
  store.setPracticeQuestions(restored.questions);
  const storedTranscript = localStorage.getItem(`voxa:transcript:${restored.id}`);
  if (storedTranscript) {
    try { store.setTurns(JSON.parse(storedTranscript)); } catch { localStorage.removeItem(`voxa:transcript:${restored.id}`); }
  }
  const mode = (session.session_mode as SessionMode) || 'class';
  store.setSessionMode(mode);
  let warning: string | undefined;
  if (mode === 'presentation' && session.slide_pages?.length && session.slide_scripts?.length) {
    store.setSlideDeck(
      session.slide_pages,
      session.slide_scripts.map(entry => ({ scriptEn: entry.scriptEn, pronunciation: entry.pronunciation, scriptEs: entry.scriptEs })),
      session.intro_script ?? null,
      session.outro_script ?? null,
    );
    try {
      const bytes = await loadPresentationPdf(session.id);
      if (bytes.length) store.setPresentationPdfBytes(bytes);
    } catch {
      warning = 'Esta presentación se restauró, pero no se encontró su PDF guardado — vuelve a subirlo en modo Presentación si hace falta.';
    }
  } else {
    store.setSlideDeck([], [], null, null);
  }
  store.prepare(session.title);
  if (mode === 'reunion') {
    store.startLive(false);
    store.setScreen('live');
  }
  return { warning };
}

/** Opens the public presenter window (presentation mode) if needed, then jumps into Live. */
async function goLiveNow(): Promise<{ error?: string }> {
  const store = useStore.getState();
  if (store.sessionMode === 'presentation') {
    if (!store.presentationPdfBytes || !store.slidePages.length) return { error: 'Falta el PDF o el guion de la presentación. Vuelve a Preparar.' };
    try {
      await setPresentationPdf(store.presentationPdfBytes);
      await openPresenterWindow(store.presentationMonitorIndex);
    } catch (cause) {
      return { error: cause instanceof Error ? cause.message : 'No se pudo abrir la ventana de presentación.' };
    }
  }
  store.startLive(false);
  store.setScreen('live');
  return {};
}

type AudioDevicePreference = { micName: string | null; loopbackName: string | null };
const AUDIO_DEVICE_STORAGE_KEY = 'voxa:audio-devices';

function loadAudioDevicePreference(): AudioDevicePreference {
  try {
    const raw = localStorage.getItem(AUDIO_DEVICE_STORAGE_KEY);
    if (!raw) return { micName: null, loopbackName: null };
    const parsed = JSON.parse(raw);
    return { micName: parsed.micName ?? null, loopbackName: parsed.loopbackName ?? null };
  } catch {
    return { micName: null, loopbackName: null };
  }
}

function saveAudioDevicePreference(preference: AudioDevicePreference) {
  localStorage.setItem(AUDIO_DEVICE_STORAGE_KEY, JSON.stringify(preference));
}

const profileInitials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || 'TU';

async function prepareProfilePhoto(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Elige una imagen JPG, PNG o WebP.');
  if (file.size > 6 * 1024 * 1024) throw new Error('La imagen debe pesar menos de 6 MB.');
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      element.src = objectUrl;
    });
    const size = Math.min(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No se pudo preparar la imagen.');
    context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 512, 512);
    return canvas.toDataURL('image/jpeg', 0.86);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="block">
    <span className="block text-sm font-semibold mb-2 text-slate-900">{label}</span>
    {children}
    {hint && <small className="block mt-1.5 text-xs text-slate-400">{hint}</small>}
  </label>;
}

type SettingsTab = 'account' | 'profile' | 'usage' | 'diagnostics';

function Sidebar({ system }: { system: SystemCheck | null }) {
  const { screen, setScreen, sessionMode, prepared } = useStore();
  return <aside className="w-[238px] shrink-0 bg-white border-r border-slate-200 flex flex-col px-4 py-5">
    <button onClick={() => setScreen('home')} className="flex items-center gap-3 px-3 pt-1 pb-8 text-left">
      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 text-white font-black flex items-center justify-center text-xl shadow-sm">V</div>
      <div><div className="font-bold text-2xl tracking-tight text-slate-900">Voxa</div><div className="text-[10px] uppercase tracking-[.18em] text-slate-400">Private copilot</div></div>
    </button>
    <nav className="space-y-1.5" aria-label="Navegación principal">
      {navItems.map(({ id, label, Icon }) => {
        const skippedForReunion = id === 'practice' && sessionMode === 'reunion';
        const unavailable = (id === 'practice' || id === 'live' || id === 'summary') && (!prepared || skippedForReunion);
        const active = screen === id;
        return <button key={id} disabled={unavailable} title={unavailable ? (skippedForReunion ? 'No aplica en modo Reunión' : 'Primero prepara una sesión') : undefined} onClick={() => setScreen(id)}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
          <Icon className="w-[18px] h-[18px]" /><span>{label}</span>
        </button>;
      })}
    </nav>
    <div className="mt-auto">
      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
          <span className={`w-2 h-2 rounded-full ${system?.apiConfigured ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          {system?.apiConfigured ? 'Sistema listo' : isNativeRuntime() ? 'Falta conectar' : 'Vista del navegador'}
        </div>
        <div className="mt-3 space-y-2 text-xs text-slate-500">
          <div className="flex justify-between"><span>Gemini</span><span>{system?.apiConfigured ? 'Conectado' : 'Pendiente'}</span></div>
          <div className="flex justify-between"><span>Micrófono</span><span>{system?.microphone ? 'Disponible' : 'Revisar'}</span></div>
        </div>
      </div>
      <p className="px-3 pt-5 text-xs italic leading-5 text-slate-400">Habla con confianza.<br />Llega más lejos.</p>
    </div>
  </aside>;
}

function Topbar({ title, subtitle, profile, openSettings }: { title: string; subtitle?: string; profile: UserProfile | null | undefined; openSettings: () => void }) {
  return <header className="h-[76px] border-b border-slate-200 bg-white/90 glass flex items-center justify-between px-8 sticky top-0 z-20">
    <div>
      <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
      {subtitle && <p className="text-sm text-slate-500 mt-0.5">{subtitle}</p>}
    </div>
    <button onClick={openSettings} className="flex items-center gap-3 rounded-xl px-3 py-2 hover:bg-slate-50 transition shrink-0">
      <div className="w-9 h-9 rounded-full bg-slate-900 text-white flex items-center justify-center text-xs font-semibold overflow-hidden shrink-0">
        {profile?.photoDataUrl ? <img src={profile.photoDataUrl} alt="" className="w-full h-full object-cover" /> : profileInitials(profile?.name || '')}
      </div>
      <div className="text-left hidden lg:block">
        <div className="text-sm font-semibold text-slate-900">{profile?.name?.trim() || 'Tu perfil'}</div>
        <div className="text-xs text-slate-400">Perfil</div>
      </div>
      <ChevronDown className="w-4 h-4 text-slate-400" />
    </button>
  </header>;
}

function Shell({ title, subtitle, system, profile, openSettings, children }: { title: string; subtitle?: string; system: SystemCheck | null; profile: UserProfile | null | undefined; openSettings: () => void; children: ReactNode }) {
  return <main className="h-screen p-4">
    <div className="h-[calc(100vh-32px)] max-w-[1600px] mx-auto bg-[#fbfcfe] border border-slate-200 rounded-2xl shadow-soft overflow-hidden flex">
      <Sidebar system={system} />
      <section className="flex-1 min-w-0 overflow-y-auto">
        <Topbar title={title} subtitle={subtitle} profile={profile} openSettings={openSettings} />
        <div className="p-7 lg:p-8 fade">{children}</div>
      </section>
    </div>
  </main>;
}

const screenMeta: Partial<Record<Screen, { title: string; subtitle?: string }>> = {
  home: { title: 'Bienvenido a Voxa', subtitle: 'Tu espacio de preparación y apoyo en vivo' },
  prepare: { title: 'Preparar sesión', subtitle: 'Configura el contexto que Voxa utilizará durante la sesión' },
  practice: { title: 'Práctica', subtitle: 'Ensaya las preguntas difíciles antes de comenzar' },
  history: { title: 'Sesiones', subtitle: 'Todo tu trabajo preparado y guardado localmente' },
  summary: { title: 'Resumen de sesión', subtitle: 'Vista final de resultados y accesos rápidos' },
  settings: { title: 'Perfil y configuración', subtitle: 'Administra tu perfil, Gemini, uso y diagnóstico técnico' },
};

function App() {
  const store = useStore();
  const [system, setSystem] = useState<SystemCheck | null>(null);
  const [profile, setProfile] = useState<UserProfile | null | undefined>(undefined);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('account');

  useEffect(() => {
    checkSystem().then(setSystem).catch(() => setSystem({ microphone: false, loopback: false, internet: false, apiConfigured: false }));
  }, []);
  useEffect(() => {
    getUserProfile().then(setProfile).catch(() => setProfile({ name: '', professionalContext: '', vocabulary: [] }));
  }, []);
  useEffect(() => {
    const open = () => { setSettingsTab('account'); store.setScreen('settings'); };
    window.addEventListener('voxa-open-settings', open);
    return () => window.removeEventListener('voxa-open-settings', open);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return;
      if (event.code === 'Space' && useStore.getState().screen === 'live' && !event.ctrlKey && !event.shiftKey) {
        event.preventDefault(); window.dispatchEvent(new Event('voxa-toggle-listening')); return;
      }
      if (!(event.ctrlKey && event.shiftKey) || useStore.getState().screen !== 'live') return;
      if (event.key.toLowerCase() === 's') window.dispatchEvent(new CustomEvent('voxa-answer-variant', { detail: 'shorter' }));
      if (event.key.toLowerCase() === 'm') window.dispatchEvent(new CustomEvent('voxa-answer-variant', { detail: 'more' }));
      if (event.key.toLowerCase() === 'a') window.dispatchEvent(new CustomEvent('voxa-answer-variant', { detail: 'alternative' }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openSettings = (tab: SettingsTab = 'profile') => { setSettingsTab(tab); store.setScreen('settings'); };
  const meta = store.screen === 'live'
    ? { title: 'En vivo', subtitle: store.sessionMode === 'presentation' ? 'Presentación · Teleprompter privado y control de pantalla' : `${sessionModeLabel[store.sessionMode]} · Escucha y asistencia en tiempo real` }
    : (screenMeta[store.screen] || { title: 'Voxa' });

  return <>
    <Shell title={meta.title} subtitle={meta.subtitle} system={system} profile={profile} openSettings={() => openSettings('profile')}>
      {store.screen === 'home' && <HomeScreen system={system} profile={profile} openSettings={openSettings} />}
      {store.screen === 'prepare' && <Prepare system={system} />}
      {store.screen === 'practice' && <Practice />}
      {store.screen === 'live' && <><LiveAudioBridge /><Live /></>}
      {store.screen === 'summary' && <SessionSummary />}
      {store.screen === 'history' && <HistoryScreen />}
      {store.screen === 'settings' && <Settings initialTab={settingsTab} system={system} setSystem={setSystem} profile={profile} setProfile={setProfile} />}
    </Shell>
    {profile === null && <Onboarding onComplete={setProfile} />}
  </>;
}

function HomeScreen({ system, profile, openSettings }: { system: SystemCheck | null; profile: UserProfile | null | undefined; openSettings: (tab: SettingsTab) => void }) {
  const { setScreen, setSessionMode, prepared, sessionMode } = useStore();
  const [recent, setRecent] = useState<SavedSession[] | null>(null);
  const [screensOk, setScreensOk] = useState<boolean | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [homeError, setHomeError] = useState('');

  useEffect(() => {
    loadSessions().then(list => setRecent(list.slice().sort(byRecency).slice(0, 3))).catch(() => setRecent([]));
  }, []);
  useEffect(() => {
    listMonitors().then(list => setScreensOk(list.length > 0)).catch(() => setScreensOk(false));
  }, []);

  const startMode = (mode: SessionMode) => { setSessionMode(mode); setScreen('prepare'); };
  const openRecent = async (session: SavedSession) => {
    setOpeningId(session.id); setHomeError('');
    try {
      const { warning } = await applyRestoredSession(session);
      if (warning) setHomeError(warning);
    } catch (cause) {
      setHomeError(cause instanceof Error ? cause.message : 'No se pudo abrir la sesión.');
    } finally {
      setOpeningId(null);
    }
  };

  const cards: { mode: SessionMode; name: string; Icon: typeof GraduationCap; desc: string }[] = [
    { mode: 'class', name: 'Clase', Icon: GraduationCap, desc: 'Saca más provecho a tus clases con resúmenes y puntos clave.' },
    { mode: 'presentation', name: 'Presentación', Icon: PresentationIcon, desc: 'Ensaya, presenta con teleprompter privado y responde preguntas con seguridad.' },
    { mode: 'reunion', name: 'Reunión', Icon: Users, desc: 'Escucha, traduce y obtén sugerencias contextualizadas sin perder el foco.' },
  ];

  const checks: [string, boolean | null, string][] = [
    ['Gemini', system?.apiConfigured ?? null, system?.apiConfigured ? 'Conectado' : 'Pendiente'],
    ['Micrófono', system?.microphone ?? null, system?.microphone ? 'Listo' : 'Revisar'],
    ['Audio del sistema', system?.loopback ?? null, system?.loopback ? 'Listo' : 'Revisar'],
    ['Pantallas', screensOk, screensOk === null ? 'Comprobando…' : screensOk ? 'Listo' : 'Sin detectar'],
  ];

  return <>
    <section className="relative overflow-hidden rounded-3xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-indigo-50 p-8 lg:p-10">
      <div className="max-w-3xl relative z-10">
        <p className="text-xs font-semibold uppercase tracking-[.18em] text-blue-600">Conversaciones más claras, grandes resultados</p>
        <h2 className="mt-4 text-4xl lg:text-5xl font-bold tracking-tight leading-[1.06] text-slate-900">{profile?.name?.trim() ? `Bienvenido de vuelta, ${profile.name.trim().split(/\s+/)[0]}` : 'Tu copiloto privado para clases, presentaciones y reuniones'}</h2>
        <p className="mt-5 max-w-2xl text-lg leading-7 text-slate-600">Escucha, transcribe y te ayuda a responder en tiempo real para que te concentres en lo importante.</p>
        <div className="mt-7 flex flex-wrap gap-3">
          <button onClick={() => setScreen('prepare')} className="rounded-xl bg-blue-600 text-white px-5 py-3 font-semibold flex items-center gap-2 hover:bg-blue-700"><Play className="w-4 h-4" /> Nueva sesión</button>
          <button disabled={!prepared} onClick={() => setScreen(sessionMode === 'reunion' ? 'live' : 'practice')} className="rounded-xl border border-slate-200 bg-white px-5 py-3 font-semibold text-slate-700 flex items-center gap-2 hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"><FolderOpen className="w-4 h-4" /> Continuar sesión</button>
        </div>
      </div>
      <div className="hidden xl:block absolute right-12 top-10 w-[320px] h-[220px]">
        <div className="absolute inset-0 rounded-3xl bg-blue-100 rotate-[-5deg]" />
        <div className="absolute inset-3 rounded-3xl border border-white/80 bg-white/85 shadow-card p-6">
          <div className="h-3 w-32 rounded-full bg-blue-100" />
          <div className="mt-8 space-y-3">
            <div className="h-2.5 w-44 bg-slate-100 rounded-full" />
            <div className="h-2.5 w-52 bg-slate-100 rounded-full" />
            <div className="h-2.5 w-36 bg-slate-100 rounded-full" />
          </div>
        </div>
        <div className="absolute -left-8 bottom-6 rounded-2xl bg-white shadow-lg px-4 py-3 text-sm text-blue-700 flex items-center gap-2"><AudioLines className="w-5 h-5" /> Escuchando…</div>
      </div>
    </section>

    <section className="grid md:grid-cols-3 gap-4 mt-5">
      {cards.map(({ mode, name, Icon, desc }) => (
        <button key={mode} onClick={() => startMode(mode)} className="text-left rounded-2xl border border-slate-200 bg-white p-6 hover:-translate-y-0.5 hover:shadow-card transition">
          <div className={`w-12 h-12 rounded-xl ${tone[mode]} flex items-center justify-center`}><Icon className="w-6 h-6" /></div>
          <h3 className="mt-5 text-lg font-bold text-slate-900">{name}</h3>
          <p className="mt-2 text-sm leading-6 text-slate-500">{desc}</p>
          <div className="mt-5 text-sm font-semibold text-blue-600">Preparar {name.toLowerCase()} <ArrowRight className="inline w-3.5 h-3.5" /></div>
        </button>
      ))}
    </section>

    <section className="grid xl:grid-cols-[1fr_360px] gap-4 mt-5">
      <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
        <div className="px-6 py-5 flex items-center justify-between">
          <h3 className="font-bold text-lg text-slate-900">Sesiones recientes</h3>
          <button onClick={() => setScreen('history')} className="text-sm font-semibold text-blue-600 flex items-center gap-1">Ver todas <ArrowRight className="w-3.5 h-3.5" /></button>
        </div>
        {homeError && <p className="px-6 pb-3 flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="w-4 h-4" />{homeError}</p>}
        <div className="px-4 pb-4">
          {recent === null ? <p className="px-2 pb-4 text-sm text-slate-400">Cargando…</p>
            : recent.length ? recent.map(session => {
              const mode = (session.session_mode as SessionMode) || 'class';
              const ModeIcon = sessionModeIcon[mode];
              return <button key={session.id} disabled={openingId === session.id} onClick={() => void openRecent(session)}
                className="w-full grid grid-cols-[1.5fr_.7fr_.8fr_24px] gap-3 items-center border-t border-slate-100 first:border-t-0 px-3 py-4 text-left hover:bg-slate-50 rounded-lg disabled:opacity-50 disabled:cursor-wait">
                <div className="flex items-center gap-3 min-w-0"><span className={`w-8 h-8 rounded-lg ${tone[mode]} flex items-center justify-center shrink-0`}><ModeIcon className="w-4 h-4" /></span><span className="font-medium text-sm truncate text-slate-900">{session.title}</span></div>
                <span className="text-sm text-slate-500">{sessionModeLabel[mode]}</span>
                <span className="text-sm text-slate-400">{sessionDateLabel(session.id)}</span>
                <MoreHorizontal className="w-4 h-4 text-slate-400" />
              </button>;
            }) : <p className="px-2 pb-4 text-sm text-slate-400">Todavía no has preparado ninguna sesión.</p>}
        </div>
      </div>
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="font-bold text-slate-900">Comprobación rápida</h3>
          {checks.map(([label, ok, text]) => (
            <div key={label} className="flex items-center justify-between mt-4 text-sm">
              <div className="flex items-center gap-3 text-slate-700">
                <span className={`w-5 h-5 text-white rounded-full flex items-center justify-center text-xs shrink-0 ${ok ? 'bg-emerald-500' : 'bg-amber-400'}`}>{ok ? '✓' : '!'}</span>{label}
              </div>
              <span className="text-slate-400">{text}</span>
            </div>
          ))}
        </div>
        <button onClick={() => openSettings('account')} className="w-full text-left rounded-2xl border border-slate-200 bg-white p-5 flex gap-4 hover:bg-slate-50">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0"><Lock className="w-5 h-5" /></div>
          <div><p className="text-sm font-medium text-slate-900">Privado por diseño</p><p className="mt-1 text-xs leading-5 text-slate-500">Audio no almacenado, transcripción local y token seguro en Windows.</p></div>
        </button>
      </div>
    </section>
  </>;
}

function HistoryScreen() {
  const { setScreen } = useStore();
  const [sessions, setSessions] = useState<SavedSession[] | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SavedSession | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadSessions().then(list => setSessions(list.slice().sort(byRecency))).catch(() => setSessions([]));
  }, []);

  const openSession = async (session: SavedSession) => {
    setOpeningId(session.id); setError('');
    try {
      const { warning } = await applyRestoredSession(session);
      if (warning) setError(warning);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo abrir la sesión.');
    } finally {
      setOpeningId(null);
    }
  };
  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteSession(pendingDelete.id);
      localStorage.removeItem(`voxa:transcript:${pendingDelete.id}`);
      setSessions(current => (current || []).filter(session => session.id !== pendingDelete.id));
      setPendingDelete(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo eliminar la sesión.');
    } finally {
      setDeleting(false);
    }
  };

  const filtered = (sessions || []).filter(session => session.title.toLowerCase().includes(query.trim().toLowerCase()));

  return <div className="rounded-2xl border border-slate-200 bg-white">
    <div className="p-6 border-b border-slate-100 flex flex-col md:flex-row md:items-center gap-4 justify-between">
      <div><h2 className="text-xl font-bold text-slate-900">Sesiones guardadas</h2><p className="text-sm text-slate-500 mt-1">Recupera contextos, guiones y transcripciones locales.</p></div>
      <div className="flex gap-2">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input value={query} onChange={event => setQuery(event.target.value)} className="pl-9 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm" placeholder="Buscar sesión" />
        </div>
        <button onClick={() => setScreen('prepare')} className="px-4 py-2.5 rounded-xl bg-blue-600 text-white font-semibold text-sm">Nueva sesión</button>
      </div>
    </div>
    {error && <p className="px-6 pt-4 flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="w-4 h-4" />{error}</p>}
    <div className="p-4">
      <div className="grid grid-cols-[1.6fr_.6fr_.8fr_.5fr_32px] gap-4 px-4 py-3 text-xs font-semibold text-slate-400 uppercase tracking-[.12em]"><div>Nombre</div><div>Modo</div><div>Última actividad</div><div>Estado</div><div /></div>
      {sessions === null ? <p className="px-4 py-6 text-sm text-slate-400">Cargando…</p>
        : filtered.length ? filtered.map(session => {
          const mode = (session.session_mode as SessionMode) || 'class';
          const ModeIcon = sessionModeIcon[mode];
          return <div key={session.id} className="grid grid-cols-[1.6fr_.6fr_.8fr_.5fr_32px] gap-4 items-center px-4 py-4 border-t border-slate-100 hover:bg-slate-50 rounded-lg">
            <button disabled={openingId === session.id} onClick={() => void openSession(session)} className="flex items-center gap-3 min-w-0 text-left disabled:opacity-50 disabled:cursor-wait">
              <span className={`w-9 h-9 rounded-xl ${tone[mode]} flex items-center justify-center shrink-0`}><ModeIcon className="w-4 h-4" /></span>
              <span className="min-w-0"><span className="block font-semibold text-sm truncate text-slate-900">{session.title}</span><span className="block text-xs text-slate-400 mt-1">Contexto y transcripción disponibles</span></span>
            </button>
            <div className="text-sm text-slate-500">{sessionModeLabel[mode]}</div>
            <div className="text-sm text-slate-500">{sessionDateLabel(session.id)}</div>
            <div><span className="text-xs px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 font-semibold">Guardada</span></div>
            <button onClick={() => setPendingDelete(session)} aria-label={`Eliminar ${session.title}`}><MoreHorizontal className="w-4 h-4 text-slate-400" /></button>
          </div>;
        }) : <p className="px-4 py-6 text-sm text-slate-400">{query ? 'Ninguna sesión coincide con tu búsqueda.' : 'Todavía no hay sesiones guardadas.'}</p>}
    </div>
    {pendingDelete && <ConfirmDialog title="Eliminar sesión guardada" message={`Esto elimina "${pendingDelete.title}" y su transcripción guardada. No se puede deshacer.`} confirmLabel="Eliminar" danger busy={deleting} onConfirm={() => void confirmDelete()} onCancel={() => setPendingDelete(null)} />}
  </div>;
}

function SessionSummary() {
  const { sessionTitle, sessionMode, turns, practiceQuestions, liveElapsedSeconds, setScreen } = useStore();
  const themTurns = turns.filter(turn => turn.speaker === 'THEM');
  const highlighted = themTurns.slice(-3).reverse();
  const exportSummary = () => {
    const body = turns.map(turn => `${turn.time} · ${turn.speaker === 'ME' ? 'Tú' : 'Computador'}\n${turn.text}${turn.translation ? `\n${turn.translation}` : ''}`).join('\n\n');
    const blob = new Blob([`${sessionTitle}\n\n${body || 'No hubo transcripción disponible.'}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${sessionTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'voxa-session'}-resumen.txt`; link.click(); URL.revokeObjectURL(url);
  };
  const stats: [string, string, typeof MessagesSquare][] = [
    ['Intervenciones', String(turns.length), MessagesSquare],
    ['Preguntas escuchadas', String(themTurns.length), CircleHelp],
    ['Preguntas preparadas', practiceQuestions.length ? String(practiceQuestions.length) : '—', Brain],
    ['Duración', formatHms(liveElapsedSeconds), Timer],
  ];
  return <div className="max-w-5xl mx-auto">
    <div className="rounded-3xl bg-gradient-to-br from-slate-900 to-slate-800 text-white p-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-5">
        <div>
          <p className="text-xs uppercase tracking-[.18em] text-slate-400">Sesión finalizada</p>
          <h2 className="mt-2 text-3xl font-bold">{sessionTitle}</h2>
          <p className="mt-2 text-slate-400">{sessionModeLabel[sessionMode]} · {formatHms(liveElapsedSeconds)}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={exportSummary} className="rounded-xl bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20">Exportar transcripción</button>
          <button onClick={() => setScreen('prepare')} className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold hover:bg-blue-500">Preparar otra</button>
        </div>
      </div>
    </div>
    <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-5">
      {stats.map(([label, value, StatIcon]) => (
        <div key={label} className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><StatIcon className="w-5 h-5" /></div>
          <div className="mt-4 text-2xl font-bold text-slate-900">{value}</div>
          <div className="text-sm text-slate-500 mt-1">{label}</div>
        </div>
      ))}
    </div>
    <div className="grid lg:grid-cols-[1fr_320px] gap-4 mt-5">
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h3 className="font-bold text-lg text-slate-900">Preguntas destacadas</h3>
        {highlighted.length ? highlighted.map((turn, index) => (
          <div key={turn.id} className={`mt-4 pt-4 ${index ? 'border-t border-slate-100' : ''}`}>
            <div className="text-sm font-semibold text-slate-900">{turn.text}</div>
            <div className="text-xs text-slate-400 mt-1">{turn.translation || 'Traducción no disponible'}</div>
          </div>
        )) : <p className="mt-4 text-sm text-slate-400">No se detectaron preguntas de la audiencia en esta sesión.</p>}
      </div>
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <h3 className="font-bold text-lg text-slate-900">Siguientes pasos</h3>
        <button onClick={() => setScreen('practice')} className="w-full mt-4 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-left hover:bg-slate-50">Volver a práctica →</button>
        <button onClick={() => setScreen('history')} className="w-full mt-2 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-left hover:bg-slate-50">Ver sesiones guardadas →</button>
      </div>
    </div>
  </div>;
}

function Settings({ initialTab, system, setSystem, profile, setProfile }: { initialTab: SettingsTab; system: SystemCheck | null; setSystem: (system: SystemCheck) => void; profile: UserProfile | null | undefined; setProfile: (profile: UserProfile) => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');
  const [health, setHealth] = useState<GeminiHealthReport | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [profileContext, setProfileContext] = useState('');
  const [profileVocabulary, setProfileVocabulary] = useState('');
  const [profilePhoto, setProfilePhoto] = useState('');
  const [photoError, setPhotoError] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState('');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [usageResetting, setUsageResetting] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [audioDevices, setAudioDevices] = useState<AudioDeviceList | null>(null);
  const [audioDevicesError, setAudioDevicesError] = useState('');
  const [audioPreference, setAudioPreference] = useState<AudioDevicePreference>(() => loadAudioDevicePreference());

  const refreshAudioDevices = () => {
    setAudioDevicesError('');
    listAudioDevices().then(setAudioDevices).catch(cause => setAudioDevicesError(cause instanceof Error ? cause.message : 'No se pudieron detectar los dispositivos de audio.'));
  };
  const updateAudioPreference = (patch: Partial<AudioDevicePreference>) => {
    setAudioPreference(current => {
      const next = { ...current, ...patch };
      saveAudioDevicePreference(next);
      return next;
    });
  };

  const runHealthCheck = async () => {
    setHealthLoading(true);
    try {
      setHealth(await checkGeminiHealth());
    } catch (cause) {
      setHealth({ overallOk: false, checks: [{ id: 'error', label: 'Diagnóstico', ok: false, message: cause instanceof Error ? cause.message : 'No se pudo ejecutar el diagnóstico.', latencyMs: 0 }] });
    } finally {
      setHealthLoading(false);
    }
  };

  const confirmResetUsage = async () => {
    setUsageResetting(true);
    try {
      await resetUsageStats();
      setUsageStats(await getUsageStats());
      setConfirmingReset(false);
    } finally {
      setUsageResetting(false);
    }
  };

  useEffect(() => {
    setProfileName(profile?.name || '');
    setProfileContext(profile?.professionalContext || '');
    setProfileVocabulary((profile?.vocabulary || []).join(', '));
    setProfilePhoto(profile?.photoDataUrl || '');
  }, [profile]);
  useEffect(() => {
    getAppInfo().then(setAppInfo).catch(() => setAppInfo(null));
    getUsageStats().then(setUsageStats).catch(() => setUsageStats(null));
    refreshAudioDevices();
  }, []);

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'profile', label: 'Perfil' },
    { id: 'account', label: 'Gemini y aplicación' },
    { id: 'usage', label: 'Uso' },
    { id: 'diagnostics', label: 'Diagnóstico' },
  ];

  return <div className="grid xl:grid-cols-[240px_1fr] gap-5">
    <aside className="rounded-2xl border border-slate-200 bg-white p-3 h-fit">
      {tabs.map(({ id, label }) => <button key={id} type="button" onClick={() => setTab(id)} className={`w-full text-left px-4 py-3 rounded-xl text-sm font-semibold ${tab === id ? 'bg-blue-50 text-blue-700' : 'text-slate-600 hover:bg-slate-50'}`}>{label}</button>)}
    </aside>
    <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:p-7">
      {tab === 'account' && <div className="space-y-5">
        <div className={`flex items-start gap-4 rounded-2xl border p-5 ${system?.apiConfigured ? 'bg-emerald-50 border-emerald-200' : 'bg-amber-50 border-amber-200'}`}>
          <span className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${system?.apiConfigured ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'}`}><ShieldCheck className="w-5 h-5" /></span>
          <div><div className="font-bold text-slate-900">{system?.apiConfigured ? 'Token de Gemini configurado' : 'Falta conectar Gemini'}</div><div className="text-sm text-slate-500 mt-1">{system?.apiConfigured ? 'La credencial está guardada de forma segura en Windows. Por seguridad, Voxa nunca vuelve a mostrar su contenido.' : 'Añade una clave API para activar la transcripción y las respuestas.'}</div></div>
        </div>
        <Field label={system?.apiConfigured ? 'Reemplazar token' : 'Clave API de Gemini'} hint={system?.apiConfigured ? 'Escribe una nueva clave únicamente si quieres sustituir la actual.' : 'La clave no se almacena dentro de los archivos de Voxa.'}>
          <input aria-label="Clave API de Gemini" type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setKeyMessage(''); }} placeholder={system?.apiConfigured ? '••••••••••••••••  Token guardado' : 'Pega aquí tu clave'} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" />
        </Field>
        {keyMessage && <p className="text-sm text-emerald-600" role="status">{keyMessage}</p>}
        <button className="rounded-xl bg-blue-600 text-white px-5 py-2.5 font-semibold text-sm disabled:opacity-50" disabled={!apiKey.trim() || savingKey} onClick={async () => {
          setSavingKey(true);
          try {
            await setGeminiApiKey(apiKey.trim());
            await validateGeminiApiKey();
            setSystem(await checkSystem());
            setKeyMessage('Clave guardada. Voxa está listo.');
            setApiKey('');
          } catch (error) { setKeyMessage(error instanceof Error ? error.message : 'La clave se guardó, pero Gemini no pudo validarla.'); }
          finally { setSavingKey(false); }
        }}>{savingKey ? 'Comprobando y guardando…' : system?.apiConfigured ? 'Reemplazar token' : 'Guardar y conectar'}</button>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-slate-200 p-5"><div className="text-sm font-semibold text-slate-900">Modelo principal</div><div className="mt-3 p-3 rounded-xl bg-slate-50 text-sm">{appInfo?.primaryModel || '—'}</div></div>
          <div className="rounded-2xl border border-slate-200 p-5"><div className="text-sm font-semibold text-slate-900">Modelos de respaldo</div><div className="mt-3 p-3 rounded-xl bg-slate-50 text-sm">{appInfo?.fallbackModels?.join(', ') || '—'}</div></div>
        </div>
        <div className="rounded-2xl border border-slate-200 p-5">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">Dispositivos de audio</div>
            <button type="button" onClick={refreshAudioDevices} className="text-xs font-semibold text-blue-600">Actualizar lista</button>
          </div>
          <p className="mt-1 text-xs text-slate-500">Elige qué micrófono usar y de qué salida de audio escuchar a la otra persona. El cambio aplica la próxima vez que empieces a escuchar.</p>
          {audioDevicesError && <p className="mt-3 flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="w-4 h-4" />{audioDevicesError}</p>}
          <div className="grid md:grid-cols-2 gap-4 mt-4">
            <Field label="Micrófono">
              <select value={audioPreference.micName ?? ''} onChange={event => updateAudioPreference({ micName: event.target.value || null })} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300">
                <option value="">Predeterminado del sistema</option>
                {audioDevices?.inputs.map(device => <option key={device.name} value={device.name}>{device.name}{device.isDefault ? ' (predeterminado)' : ''}</option>)}
              </select>
            </Field>
            <Field label="Audio del sistema" hint="El dispositivo de salida cuyo audio Voxa escucha para transcribir a la otra persona.">
              <select value={audioPreference.loopbackName ?? ''} onChange={event => updateAudioPreference({ loopbackName: event.target.value || null })} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300">
                <option value="">Predeterminado del sistema</option>
                {audioDevices?.outputs.map(device => <option key={device.name} value={device.name}>{device.name}{device.isDefault ? ' (predeterminado)' : ''}</option>)}
              </select>
            </Field>
          </div>
        </div>
        <div className="rounded-2xl border border-slate-200 overflow-hidden">
          {[['Versión', appInfo?.version || '—'], ['Datos guardados en', appInfo?.dataDir || '—']].map(([label, value], index) => (
            <div key={label} className={`px-5 py-4 flex justify-between gap-4 text-sm ${index ? 'border-t border-slate-100' : ''}`}><span className="text-slate-500">{label}</span><span className={`font-medium text-right ${label === 'Datos guardados en' ? 'font-mono text-xs text-slate-500 break-all' : 'text-slate-900'}`}>{value}</span></div>
          ))}
        </div>
      </div>}
      {tab === 'profile' && <div className="space-y-5">
        <div className="flex items-center gap-6">
          <div className="w-24 h-24 rounded-full bg-slate-900 text-white flex items-center justify-center text-2xl font-bold shrink-0 overflow-hidden">{profilePhoto ? <img src={profilePhoto} alt="" className="w-full h-full object-cover" /> : profileInitials(profileName)}</div>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[.16em] text-blue-600 font-semibold">Tu perfil</p>
            <h2 className="mt-1 text-xl font-bold text-slate-900">{profileName.trim() || 'Completa tu identidad'}</h2>
            <p className="mt-1 text-sm text-slate-500">Voxa usa estos datos para adaptar el tono, el vocabulario y el nivel de tus respuestas.</p>
            <div className="mt-3 flex items-center gap-3">
              <label className="relative overflow-hidden rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold cursor-pointer hover:bg-slate-50">
                {profilePhoto ? 'Cambiar foto' : 'Añadir foto'}
                <input type="file" accept="image/jpeg,image/png,image/webp" className="absolute inset-0 opacity-0 cursor-pointer" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; setPhotoError(''); try { setProfilePhoto(await prepareProfilePhoto(file)); } catch (cause) { setPhotoError(cause instanceof Error ? cause.message : 'No se pudo usar la imagen.'); } finally { event.target.value = ''; } }} />
              </label>
              {profilePhoto && <button type="button" onClick={() => { setProfilePhoto(''); setPhotoError(''); }} className="text-sm font-semibold text-red-600">Quitar</button>}
            </div>
          </div>
        </div>
        {photoError && <p className="flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="w-4 h-4" />{photoError}</p>}
        <div className="border-t border-slate-100" />
        <Field label="Nombre visible"><input value={profileName} onChange={event => { setProfileName(event.target.value); setProfileMessage(''); }} placeholder="¿Cómo quieres que te llame Voxa?" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
        <Field label="Contexto profesional" hint="Este contexto se aplica a todas las sesiones; el contexto específico se añade al preparar cada una."><textarea value={profileContext} onChange={event => { setProfileContext(event.target.value); setProfileMessage(''); }} placeholder="Tu función, empresa, equipo y tipo de trabajo habitual" className="w-full min-h-[110px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
        <Field label="Vocabulario que Voxa debe recordar"><textarea value={profileVocabulary} onChange={event => { setProfileVocabulary(event.target.value); setProfileMessage(''); }} placeholder="Productos, siglas, tecnologías y nombres propios, separados por comas" className="w-full min-h-[110px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
        <div className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600"><ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" /><span><strong className="text-slate-900">Perfil local.</strong> La foto permanece en este dispositivo y no se incluye en las solicitudes a Gemini.</span></div>
        {profileMessage && <p className="text-sm text-emerald-600" role="status">{profileMessage}</p>}
        <button disabled={profileSaving || !profileName.trim()} className="rounded-xl bg-blue-600 text-white px-5 py-2.5 font-semibold text-sm disabled:opacity-50" onClick={async () => {
          setProfileSaving(true);
          try {
            const saved: UserProfile = { name: profileName.trim(), professionalContext: profileContext.trim(), vocabulary: profileVocabulary.split(/[,;\n]/).map(term => term.trim()).filter(Boolean), photoDataUrl: profilePhoto || undefined };
            await saveUserProfile(saved);
            setProfile(saved);
            setProfileMessage('Perfil actualizado. Voxa usará estos datos en las próximas sesiones.');
          } catch (cause) {
            setProfileMessage(cause instanceof Error ? cause.message : 'No se pudo guardar el perfil.');
          } finally {
            setProfileSaving(false);
          }
        }}>{profileSaving ? 'Guardando perfil…' : 'Guardar cambios'}</button>
      </div>}
      {tab === 'usage' && <div>
        <div className="flex items-center justify-between mb-4"><p className="text-xs uppercase tracking-[.16em] text-blue-600 font-semibold">Uso y gasto acumulado</p><button onClick={() => setConfirmingReset(true)} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50">Reiniciar contador</button></div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {([
            ['Gasto estimado', `$ ${(usageStats?.totalCostUsd || 0).toFixed(4)}`, Wallet],
            ['Llamadas a Gemini', String(usageStats?.totalCalls || 0), Activity],
            ['Tokens de entrada', (usageStats?.totalInputTokens || 0).toLocaleString(), ArrowDownToLine],
            ['Tokens de salida', (usageStats?.totalOutputTokens || 0).toLocaleString(), ArrowUpFromLine],
          ] as [string, string, typeof Wallet][]).map(([label, value, IconComp]) => (
            <div key={label} className="rounded-2xl border border-slate-200 p-5"><div className="w-10 h-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center"><IconComp className="w-5 h-5" /></div><div className="mt-4 text-2xl font-bold text-slate-900">{value}</div><div className="text-sm text-slate-500 mt-1">{label}</div></div>
          ))}
        </div>
        <p className="mt-5 text-xs text-slate-400 leading-5">Este total acumula todas las sesiones desde que se instaló (o desde el último reinicio del contador); es independiente del costo estimado que ves durante una sesión En vivo.</p>
      </div>}
      {tab === 'diagnostics' && <div>
        <div className="flex items-center justify-between mb-4"><p className="text-xs uppercase tracking-[.16em] text-blue-600 font-semibold">Estado de Gemini</p><button onClick={runHealthCheck} disabled={healthLoading} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50">{healthLoading ? 'Comprobando…' : 'Ejecutar diagnóstico'}</button></div>
        {health && <div className="space-y-3">
          {health.checks.map(check => (
            <div key={check.id} className="rounded-2xl border border-slate-200 p-5 flex items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <span className={`w-10 h-10 rounded-xl flex items-center justify-center ${check.ok ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}><CircleCheck className="w-5 h-5" /></span>
                <div><div className="font-semibold text-slate-900">{check.label}</div><div className="text-sm text-slate-500 mt-1">{check.message}</div></div>
              </div>
              {check.latencyMs > 0 && <span className="text-sm text-slate-400 shrink-0">{check.latencyMs} ms</span>}
            </div>
          ))}
        </div>}
      </div>}
    </section>
    {confirmingReset && <ConfirmDialog title="Reiniciar contador de gasto" message="Esto borra el historial acumulado de gasto en Gemini (costo, llamadas y tokens desde siempre). No se puede deshacer." confirmLabel="Reiniciar" danger busy={usageResetting} onConfirm={() => void confirmResetUsage()} onCancel={() => setConfirmingReset(false)} />}
  </div>;
}

function ConfirmDialog({ title, message, confirmLabel, danger, busy, onConfirm, onCancel }: { title: string; message: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-5" onClick={onCancel}>
    <section role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={event => event.stopPropagation()} className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-soft">
      <h2 id="confirm-title" className="text-xl font-bold text-slate-900">{title}</h2>
      <p className="mt-3 text-sm text-slate-500 leading-6">{message}</p>
      <div className="flex justify-end gap-3 mt-6 pt-5 border-t border-slate-100">
        <button onClick={onCancel} disabled={busy} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Cancelar</button>
        <button onClick={onConfirm} disabled={busy} className={`rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>{busy ? 'Un momento…' : confirmLabel}</button>
      </div>
    </section>
  </div>;
}

function Onboarding({ onComplete }: { onComplete: (profile: UserProfile) => void }) {
  const [name, setName] = useState('');
  const [professionalContext, setProfessionalContext] = useState('');
  const [vocabulary, setVocabulary] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const finish = async (skip: boolean) => {
    setSaving(true); setError('');
    const saved: UserProfile = skip
      ? { name: '', professionalContext: '', vocabulary: [] }
      : { name: name.trim(), professionalContext: professionalContext.trim(), vocabulary: vocabulary.split(/[,;\n]/).map(term => term.trim()).filter(Boolean) };
    try {
      await saveUserProfile(saved);
      onComplete(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar tu perfil.');
    } finally {
      setSaving(false);
    }
  };

  return <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-5">
    <section role="dialog" aria-modal="true" aria-labelledby="onboarding-title" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-soft">
      <p className="text-xs uppercase tracking-[.16em] text-blue-600 font-semibold">Bienvenido a Voxa</p>
      <h2 id="onboarding-title" className="mt-1 text-xl font-bold text-slate-900">Cuéntale a Voxa sobre ti</h2>
      <p className="mt-3 text-sm text-slate-500 leading-6">Esto ayuda al copiloto a personalizar sus respuestas y a recordar tu vocabulario técnico entre sesiones. Puedes editarlo luego desde Configuración.</p>
      <div className="mt-5 space-y-4">
        <Field label="Tu nombre"><input value={name} onChange={event => setName(event.target.value)} placeholder="Ej.: Charlie Cárdenas" autoFocus className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
        <Field label="Tu contexto profesional"><textarea value={professionalContext} onChange={event => setProfessionalContext(event.target.value)} placeholder="Empresa, equipo o rol habitual" className="w-full min-h-[90px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
        <Field label="Vocabulario técnico que usas seguido"><textarea value={vocabulary} onChange={event => setVocabulary(event.target.value)} placeholder="Nombres de producto, siglas, tecnologías (opcional)" className="w-full min-h-[90px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
      </div>
      {error && <p className="mt-4 flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="w-4 h-4" />{error}</p>}
      <div className="flex justify-end gap-3 mt-6 pt-5 border-t border-slate-100">
        <button disabled={saving} onClick={() => void finish(true)} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Omitir por ahora</button>
        <button disabled={saving || !name.trim()} onClick={() => void finish(false)} className="rounded-xl bg-blue-600 text-white px-4 py-2.5 text-sm font-semibold disabled:opacity-50">{saving ? 'Guardando…' : 'Empezar a usar Voxa'}</button>
      </div>
    </section>
  </div>;
}

type PrepareStep = 1 | 2 | 3;

function Prepare({ system }: { system: SystemCheck | null }) {
  const { markPrepared, setSessionTitle, setSessionId, setPracticeQuestions, sessionMode, setSessionMode, setSlideDeck, setPresentationPdfBytes, setPresentationMonitorIndex, slidePages, presentationPdfBytes } = useStore();
  const title = useStore(state => state.sessionTitle);
  const [step, setStep] = useState<PrepareStep>(1);
  const [file, setFile] = useState<File | null>(null);
  const [vocabulary, setVocabulary] = useState('');
  const [role, setRole] = useState('Desarrollador de software');
  const [audience, setAudience] = useState('Engineering team');
  const [level, setLevel] = useState('B2');
  const [responseLength, setResponseLength] = useState('Short');
  const [importantFacts, setImportantFacts] = useState('');
  const [forbiddenClaims, setForbiddenClaims] = useState('');
  const [context, setContext] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [prepareStep, setPrepareStep] = useState('');
  const [stepReady, setStepReady] = useState(false);
  const [error, setError] = useState('');
  const [monitors, setMonitors] = useState<MonitorInfo[] | null>(null);
  const [selectedMonitor, setSelectedMonitor] = useState(0);
  const [starting, setStarting] = useState(false);
  const prepareGenerationRef = useRef(0);

  const runPrepare = async () => {
    const generation = ++prepareGenerationRef.current;
    setPreparing(true); setError(''); setPrepareStep(''); setStepReady(false);
    try {
      if (sessionMode === 'presentation' && (!file || !file.name.toLowerCase().endsWith('.pdf'))) {
        setError('El modo presentación necesita un archivo PDF.');
        return;
      }
      let preparedVocabulary = vocabulary;
      let presentationPages: string[] | null = null;
      let presentationBytes: Uint8Array | null = null;
      if (file) {
        setPrepareStep('Extrayendo texto del documento…');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const extracted = await extractDocument(file.name, bytes);
        if (generation !== prepareGenerationRef.current) return;
        if (extracted.vocabulary.length && !vocabulary.trim()) {
          preparedVocabulary = extracted.vocabulary.join(', ');
          setVocabulary(preparedVocabulary);
        }
        if (sessionMode === 'presentation') {
          if (!extracted.pages || !extracted.pages.length) {
            setError('Este PDF parece escaneado; el modo presentación necesita un PDF con texto seleccionable.');
            return;
          }
          presentationPages = extracted.pages;
          presentationBytes = bytes;
          setPresentationPdfBytes(bytes);
        }
      }
      const requestPayload: PrepareSessionRequest = { title, role, audience, level, responseLength, importantFacts, forbiddenClaims, context, vocabulary: preparedVocabulary, sessionMode };
      setPrepareStep(sessionMode === 'reunion' ? 'Preparando la sesión…' : 'Generando preguntas de práctica…');
      const session = await prepareNativeSession(requestPayload);
      if (generation !== prepareGenerationRef.current) return;
      setSessionId(session.id);
      setPracticeQuestions(session.questions);
      if (presentationPages) {
        setPrepareStep('Escribiendo el guion de la presentación…');
        const deck = await generateSlideScripts(presentationPages, requestPayload);
        if (generation !== prepareGenerationRef.current) return;
        const orderedScripts = deck.slides.slice().sort((a, b) => a.index - b.index);
        setSlideDeck(presentationPages, orderedScripts.map(entry => ({ scriptEn: entry.scriptEn, pronunciation: entry.pronunciation, scriptEs: entry.scriptEs })), deck.intro, deck.outro);
        // Best-effort: lets this exact presentation (mode + guion + PDF) be
        // reopened later from "Sesiones recientes" without redoing any of it.
        void savePresentationDeck(session.id, presentationPages, orderedScripts, deck.intro, deck.outro).catch(() => {});
        if (presentationBytes) void savePresentationPdf(session.id, presentationBytes).catch(() => {});
      }
      markPrepared(title);
      if (sessionMode === 'reunion') {
        // Nothing to rehearse when you're not presenting - skip straight to Live.
        await goLiveNow();
        return;
      }
      if (sessionMode === 'presentation') {
        setPrepareStep('Detectando monitores…');
        try {
          const list = await listMonitors();
          if (generation !== prepareGenerationRef.current) return;
          setMonitors(list);
          const defaultMonitor = list.length > 1 ? 1 : 0;
          setSelectedMonitor(defaultMonitor);
          setPresentationMonitorIndex(defaultMonitor);
          void identifyMonitors();
        } catch (cause) {
          if (generation === prepareGenerationRef.current) setError(cause instanceof Error ? cause.message : 'No se pudieron detectar los monitores.');
          return;
        }
      }
      setStepReady(true);
    } catch (cause) {
      if (generation !== prepareGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : 'No se pudo preparar la sesión.');
    } finally {
      if (generation === prepareGenerationRef.current) { setPreparing(false); setPrepareStep(''); }
    }
  };

  const goNextStep = () => {
    setError('');
    if (step === 1) { setStep(2); return; }
    if (step === 2) {
      if (sessionMode === 'presentation' && (!file || !file.name.toLowerCase().endsWith('.pdf'))) { setError('El modo presentación necesita un archivo PDF.'); return; }
      setStep(3);
      void runPrepare();
    }
  };

  const beginNow = async () => {
    setStarting(true); setError('');
    try {
      const { error: liveError } = await goLiveNow();
      if (liveError) setError(liveError);
    } finally {
      setStarting(false);
    }
  };

  const checks: [string, boolean, string][] = [
    ['Gemini', Boolean(system?.apiConfigured), system?.apiConfigured ? 'Conectado' : 'Pendiente'],
    ['Micrófono', Boolean(system?.microphone), system?.microphone ? 'Disponible' : 'Revisar'],
    ['Audio del computador', Boolean(system?.loopback), system?.loopback ? 'Disponible' : 'Revisar'],
  ];
  if (sessionMode === 'presentation') {
    checks.push(['PDF', Boolean(presentationPdfBytes), presentationPdfBytes ? `${slidePages.length} diapositivas procesadas` : 'Pendiente']);
    checks.push(['Guion', slidePages.length > 0, slidePages.length ? 'Generado correctamente' : 'Pendiente']);
  }

  const steps: [string, string][] = [
    ['Datos básicos', 'Información general de la sesión'],
    ['Contexto', 'Audiencia, nivel y restricciones'],
    ['Comprobación', 'Revisión técnica antes de comenzar'],
  ];

  return <div className="grid xl:grid-cols-[250px_1fr] gap-6">
    <aside className="rounded-2xl border border-slate-200 bg-white p-4 h-fit">
      {steps.map(([label, desc], index) => {
        const number = (index + 1) as PrepareStep;
        return <button key={label} onClick={() => number <= step && setStep(number)} disabled={number > step}
          className={`w-full text-left p-4 rounded-xl ${step === number ? 'bg-blue-50' : number < step ? 'hover:bg-slate-50' : 'opacity-50 cursor-not-allowed'}`}>
          <div className="flex items-start gap-3">
            <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${step === number ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{number}</span>
            <div><div className="text-sm font-semibold text-slate-900">{label}</div><div className="text-xs text-slate-500 mt-1">{desc}</div></div>
          </div>
        </button>;
      })}
    </aside>
    <section className="rounded-2xl border border-slate-200 bg-white p-6 lg:p-7">
      <div className="flex items-center justify-between mb-6">
        <div><p className="text-xs font-semibold uppercase tracking-[.16em] text-blue-600">Paso {step} de 3</p><h2 className="text-2xl font-bold mt-1 text-slate-900">{steps[step - 1][0]}</h2></div>
        <span className="text-sm text-slate-400">{sessionModeLabel[sessionMode]}</span>
      </div>

      {step === 1 && <div className="grid lg:grid-cols-2 gap-5">
        <Field label="Nombre de la sesión"><input value={title} onChange={event => setSessionTitle(event.target.value)} placeholder="Ej.: Revisión de arquitectura" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
        <Field label="Modalidad">
          <div className="grid grid-cols-3 gap-2">
            {(['class', 'presentation', 'reunion'] as SessionMode[]).map(mode => <button key={mode} type="button" onClick={() => setSessionMode(mode)} className={`px-3 py-3 rounded-xl border text-sm font-semibold ${sessionMode === mode ? 'bg-blue-50 border-blue-300 text-blue-700' : 'border-slate-200 bg-white text-slate-600'}`}>{sessionModeLabel[mode]}</button>)}
          </div>
        </Field>
        <Field label="Tu función o rol"><input value={role} onChange={event => setRole(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
        <Field label="Tipo de audiencia"><select value={audience} onChange={event => setAudience(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"><option value="Engineering team">Equipo de ingeniería</option><option value="Managers">Directivos</option><option value="Mixed audience">Audiencia mixta</option></select></Field>
        <Field label="Nivel de inglés"><select value={level} onChange={event => setLevel(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"><option>B1</option><option>B2</option><option>C1</option></select></Field>
        <Field label="Extensión de la respuesta"><select value={responseLength} onChange={event => setResponseLength(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300"><option value="Short">Corta</option><option value="Medium">Media</option></select></Field>
      </div>}

      {step === 2 && <div className="space-y-5">
        <div className="grid lg:grid-cols-2 gap-5">
          <Field label="Datos importantes"><textarea value={importantFacts} onChange={event => setImportantFacts(event.target.value)} placeholder="Números, fechas o decisiones que Voxa debe recordar" className="w-full min-h-[120px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
          <Field label="Afirmaciones que Voxa no debe realizar"><textarea value={forbiddenClaims} onChange={event => setForbiddenClaims(event.target.value)} placeholder="Datos desconocidos, temas sensibles o límites" className="w-full min-h-[120px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
          <Field label="Contexto específico del proyecto" hint="Esto se suma a tu perfil general (Configuración → Perfil)."><textarea value={context} onChange={event => setContext(event.target.value)} placeholder="Empresa, objetivo del proyecto y antecedentes relevantes" className="w-full min-h-[150px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
          <Field label="Vocabulario técnico" hint="Se añade al vocabulario que Voxa ya recuerda de tu perfil, no lo reemplaza."><textarea value={vocabulary} onChange={event => setVocabulary(event.target.value)} placeholder="workflow, orchestration, API gateway…" className="w-full min-h-[150px] rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300" /></Field>
        </div>
        {sessionMode === 'presentation' && <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 p-7 text-center relative">
          <div className="w-12 h-12 mx-auto rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center"><FileUp className="w-6 h-6" /></div>
          <h4 className="mt-4 font-semibold text-slate-900">{file ? file.name : 'Cargar presentación PDF'}</h4>
          <p className="mt-1 text-sm text-slate-500">{file ? 'Listo para usar.' : 'Arrastra un archivo o selecciónalo desde tu equipo.'}</p>
          <label className="mt-4 inline-block px-4 py-2.5 rounded-xl bg-white border border-slate-200 text-sm font-semibold cursor-pointer hover:bg-slate-50 relative overflow-hidden">
            <Upload className="inline w-4 h-4 mr-1" /> Seleccionar PDF
            <input type="file" accept=".pdf" className="absolute inset-0 opacity-0 cursor-pointer" onChange={event => setFile(event.target.files?.[0] || null)} />
          </label>
          <p className="mt-3 text-xs text-slate-400">Obligatorio · solo PDF · máximo 25 MB · necesita texto seleccionable.</p>
        </div>}
      </div>}

      {step === 3 && <>
        {preparing ? <div className="rounded-2xl border border-slate-200 bg-slate-50 p-10 flex flex-col items-center text-center">
          <div className="w-10 h-10 rounded-full border-2 border-blue-200 border-t-blue-600 animate-spin" />
          <p className="mt-4 text-sm font-semibold text-slate-700">{prepareStep || 'Preparando…'}</p>
        </div> : <div className="grid xl:grid-cols-[1fr_360px] gap-5">
          <div>
            <div className="rounded-2xl border border-slate-200 overflow-hidden">
              {checks.map(([label, ok, value], index) => (
                <div key={label} className={`p-5 flex items-center justify-between gap-4 ${index ? 'border-t border-slate-100' : ''}`}>
                  <div className="flex items-center gap-4 min-w-0">
                    <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${ok ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}><CircleCheck className="w-5 h-5" /></span>
                    <div className="min-w-0"><div className="font-semibold text-slate-900">{label}</div><div className="text-sm text-slate-500 mt-0.5 truncate">{value}</div></div>
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full font-semibold shrink-0 ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{ok ? 'Listo' : 'Pendiente'}</span>
                </div>
              ))}
              {sessionMode === 'presentation' && <div className="p-5 border-t border-slate-100">
                <div className="flex items-center gap-4 mb-3">
                  <span className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0"><MonitorCheck className="w-5 h-5" /></span>
                  <div><div className="font-semibold text-slate-900">Pantalla pública</div><div className="text-sm text-slate-500 mt-0.5">{monitors ? monitors.find(m => m.index === selectedMonitor)?.name : 'Detectando monitores…'}</div></div>
                </div>
                {monitors && monitors.length > 1 && <div className="grid gap-2 mt-3">
                  {monitors.map(monitor => <button key={monitor.index} type="button" onClick={() => { setSelectedMonitor(monitor.index); setPresentationMonitorIndex(monitor.index); }}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-sm ${selectedMonitor === monitor.index ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white'}`}>
                    <span className="w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-bold flex items-center justify-center shrink-0">{monitor.index + 1}</span>
                    <MonitorIcon className="w-4 h-4 text-slate-500" />
                    <span className="min-w-0"><span className="block font-semibold text-slate-900">{monitor.name}</span><span className="block text-xs text-slate-400">{monitor.width}×{monitor.height}</span></span>
                  </button>)}
                  <button type="button" onClick={() => void identifyMonitors()} className="text-xs font-semibold text-blue-600 text-left">Identificar pantallas de nuevo</button>
                </div>}
              </div>}
            </div>
          </div>
          <div className="rounded-2xl bg-slate-900 text-white p-6">
            <div className="text-xs uppercase tracking-[.18em] text-slate-400">Resumen</div>
            <h3 className="mt-3 text-xl font-bold">{sessionModeLabel[sessionMode]}</h3>
            <div className="mt-5 space-y-3 text-sm text-slate-300">
              <div className="flex justify-between"><span>Nivel</span><span className="text-white">{level}</span></div>
              <div className="flex justify-between"><span>Respuesta</span><span className="text-white">{responseLength === 'Short' ? 'Corta' : 'Media'}</span></div>
              <div className="flex justify-between"><span>Preparación</span><span className="text-white">{stepReady ? 'Completa' : 'Pendiente'}</span></div>
            </div>
            <button disabled={!stepReady || sessionMode === 'reunion'} onClick={() => useStore.getState().setScreen('practice')} className="w-full mt-7 rounded-xl bg-blue-600 hover:bg-blue-500 px-4 py-3 font-semibold disabled:opacity-40 disabled:cursor-not-allowed">Ir a práctica</button>
            <button disabled={!stepReady || starting} onClick={() => void beginNow()} className="w-full mt-2 rounded-xl bg-white/10 hover:bg-white/15 px-4 py-3 font-semibold disabled:opacity-40">{starting ? 'Abriendo…' : 'Comenzar ahora'}</button>
          </div>
        </div>}
      </>}

      {error && <p className="mt-5 flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="w-4 h-4" />{error}</p>}

      {step < 3 && <div className="flex justify-between mt-7 pt-6 border-t border-slate-100">
        <button onClick={() => setStep(Math.max(1, step - 1) as PrepareStep)} disabled={step === 1} className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white font-semibold text-sm disabled:opacity-40 disabled:pointer-events-none">Anterior</button>
        <button onClick={goNextStep} disabled={step === 1 && !title.trim()} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-semibold text-sm disabled:opacity-50">Continuar</button>
      </div>}
      {step === 3 && !preparing && error && <div className="flex justify-end mt-5"><button onClick={() => void runPrepare()} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-semibold text-sm">Reintentar</button></div>}
    </section>
  </div>;
}

function Practice() {
  const { setScreen, practiceQuestions } = useStore();
  const [selected, setSelected] = useState(0);
  const [showAnswer, setShowAnswer] = useState(true);
  const selectedItem = practiceQuestions[selected];
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const beginSession = async () => {
    setStarting(true); setError('');
    const { error: liveError } = await goLiveNow();
    if (liveError) setError(liveError);
    setStarting(false);
  };

  return <div className="grid xl:grid-cols-[360px_1fr] gap-5">
    <aside className="rounded-2xl border border-slate-200 bg-white overflow-hidden h-fit">
      <div className="p-5 border-b border-slate-100">
        <div className="flex items-center justify-between"><h3 className="font-bold text-slate-900">Preguntas probables</h3><span className="text-xs bg-blue-50 text-blue-700 rounded-full px-2.5 py-1 font-semibold">{practiceQuestions.length}</span></div>
        <p className="text-sm text-slate-500 mt-1">Generadas a partir del contexto.</p>
      </div>
      <div className="p-3 space-y-2">
        {practiceQuestions.length ? practiceQuestions.map((item, index) => (
          <button key={`${item.question}-${index}`} onClick={() => { setSelected(index); setShowAnswer(false); }}
            className={`w-full text-left rounded-xl p-4 text-sm leading-5 ${selected === index ? 'bg-blue-50 border border-blue-200 text-slate-900' : 'border border-transparent hover:bg-slate-50 text-slate-600'}`}>
            <div className="flex gap-3"><span className="text-xs font-bold text-slate-400">{String(index + 1).padStart(2, '0')}</span><span>{item.question}</span></div>
          </button>
        )) : <div className="p-2"><p className="text-sm text-slate-400">Todavía no hay preguntas para ensayar.</p><button onClick={() => setScreen('prepare')} className="mt-3 px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-semibold">Volver a preparar</button></div>}
      </div>
    </aside>
    <section className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-6">
        <div className="flex items-start justify-between gap-4">
          <div><p className="text-xs uppercase tracking-[.16em] font-semibold text-blue-600">Pregunta seleccionada</p><h2 className="mt-2 text-2xl font-bold text-slate-900">{selectedItem?.question || 'Aquí aparecerán tus preguntas.'}</h2></div>
          {selectedItem && <button onClick={() => setShowAnswer(value => !value)} className="text-sm font-semibold text-slate-500 flex items-center gap-1 shrink-0"><EyeOff className="w-4 h-4" /> {showAnswer ? 'Ocultar' : 'Mostrar'}</button>}
        </div>
        {selectedItem && <div className="mt-6 rounded-2xl bg-slate-900 text-white p-6">
          <p className="text-xs uppercase tracking-[.16em] text-slate-400">Respuesta sugerida · B2</p>
          {showAnswer ? <p className="mt-3 text-lg leading-8">{selectedItem.answer}</p> : <p className="mt-3 text-sm text-slate-400">Responde en voz alta o escribe tu idea en 30 segundos.</p>}
        </div>}
        {selectedItem && <div className="flex justify-end gap-3 mt-5">
          <button onClick={() => setShowAnswer(true)} className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-semibold flex items-center gap-1"><Check className="w-4 h-4" /> Marcar revisada</button>
        </div>}
      </div>
      {error && <p className="flex items-center gap-2 text-sm text-red-600"><AlertTriangle className="w-4 h-4" />{error}</p>}
      <div className="flex justify-end">
        <button disabled={!practiceQuestions.length || starting} onClick={() => void beginSession()} className="px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold disabled:opacity-50 flex items-center gap-2">{starting ? 'Abriendo…' : 'Comenzar sesión'} <Radio className="w-4 h-4" /></button>
      </div>
    </section>
  </div>;
}

function answerCost(usage: Pick<NativeCopilotAnswer, 'model_used' | 'input_tokens' | 'output_tokens' | 'thought_tokens'>) {
  const fallback = usage.model_used.includes('2.5-flash');
  const inputRate = fallback ? 0.30 : 0.75;
  const outputRate = fallback ? 2.50 : 3.75;
  return (usage.input_tokens * inputRate + (usage.output_tokens + usage.thought_tokens) * outputRate) / 1_000_000;
}

let answerGeneration = 0;

async function answerDetectedQuestion(question: string) {
  const generation = ++answerGeneration;
  const state = useStore.getState();
  state.setAnswerError(null);
  state.setActiveQuestion(question);
  state.setAnswerLoading(true);
  useStore.setState({ answer: null });
  const conversation = state.turns.slice(-24).map(turn => `[${turn.speaker}] ${turn.text}`).join('\n');
  try {
    const nativeAnswer = await generateCopilotAnswer(question, 'Usa el contexto preparado de la presentación. No inventes datos que falten.', conversation);
    if (!nativeAnswer) return;
    if (generation !== answerGeneration) return;
    useStore.getState().addAnswerCost(answerCost(nativeAnswer));
    useStore.getState().setAnswer({ questionEn: nativeAnswer.question_en, questionEs: nativeAnswer.question_es, answer: nativeAnswer.answer_b2, more: nativeAnswer.extension_b2, idea: nativeAnswer.key_idea_es, confidence: nativeAnswer.confidence, warning: nativeAnswer.warning || undefined });
  } catch (error) {
    if (generation === answerGeneration) useStore.getState().setAnswerError(error instanceof Error ? error.message : 'No se pudo generar la respuesta.');
    console.error('Copilot answer unavailable', error);
  } finally {
    if (generation === answerGeneration) useStore.getState().setAnswerLoading(false);
  }
}

function LiveAudioBridge() {
  const sessionId = useStore(state => state.sessionId);
  useEffect(() => {
    const timer = window.setInterval(() => { const s = useStore.getState(); s.setLiveElapsedSeconds(s.liveElapsedSeconds + 1); }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (isNativeRuntime()) useStore.getState().clearLiveDemo();
    let mounted = true;
    let sequence = 0;
    const analysisChains: Record<'ME' | 'THEM', Promise<void>> = { ME: Promise.resolve(), THEM: Promise.resolve() };
    const finalBuffers: Record<'ME' | 'THEM', string> = { ME: '', THEM: '' };
    const finalTimers: Record<'ME' | 'THEM', number | null> = { ME: null, THEM: null };
    const cleanups: (() => void)[] = [];

    const offerQuestion = (question: string) => {
      const normalized = question.trim();
      if (!normalized) return;
      const current = useStore.getState();
      if (current.sessionMode === 'reunion') return;
      const folded = normalized.toLocaleLowerCase();
      const duplicate = current.activeQuestion?.trim().toLocaleLowerCase() === folded
        || current.questionQueue.some(item => item.trim().toLocaleLowerCase() === folded);
      if (duplicate) return;
      if (current.activeQuestion || current.answerLoading || current.answer) current.enqueueQuestion(normalized);
      else void answerDetectedQuestion(normalized);
    };

    const commitFinalTranscript = (speaker: 'ME' | 'THEM', text: string) => {
      if (!mounted || !text) return;
      const now = new Date();
      const turnId = `${Date.now()}-${sequence++}-${speaker}`;
      useStore.getState().addTurn({ id: turnId, speaker, text, translating: true, time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      const analyze = async () => {
        if (!mounted) return;
        const recentConversation = useStore.getState().turns.slice(-20).map(turn => `[${turn.speaker}] ${turn.text}`).join('\n');
        try {
          const analysis = await analyzeTranscript(text, speaker, recentConversation);
          if (!mounted) return;
          if (!analysis) {
            useStore.getState().updateTurn(turnId, { translating: false });
            if (speaker === 'THEM' && looksLikeQuestion(text)) offerQuestion(text);
            return;
          }
          const store = useStore.getState();
          store.updateTurn(turnId, { translation: analysis.translation, sourceLanguage: analysis.source_language, translating: false });
          store.addAnswerCost(answerCost(analysis));
          // Reunión mode is transcription/translation only - there is no
          // presenter to hand a suggested answer to, so skip question
          // detection entirely rather than queuing answers nobody sees.
          if (store.sessionMode === 'reunion') return;
          if (speaker !== 'THEM') return;
          const classified = analysis.complete && (analysis.intent === 'QUESTION' || analysis.intent === 'REQUEST')
            ? analysis.normalized_question?.trim()
            : '';
          // A conservative local fallback prevents a transient classifier
          // failure or an incorrect "incomplete" label from losing an
          // obvious audience question.
          if (classified) offerQuestion(classified);
          else if (looksLikeQuestion(text)) offerQuestion(text);
        } catch (error) {
          if (mounted) useStore.getState().updateTurn(turnId, { translating: false });
          if (mounted && speaker === 'THEM' && looksLikeQuestion(text)) offerQuestion(text);
          console.error('Live translation unavailable', error);
        }
      };
      analysisChains[speaker] = analysisChains[speaker].then(analyze, analyze);
    };

    const handleTranscript = (transcript: Parameters<Parameters<typeof onNativeTranscript>[0]>[0]) => {
      if (!mounted) return;
      const text = transcript.text.trim();
      if (!text) return;
      if (transcript.interim) {
        useStore.getState().setInterimTranscript(transcript.speaker, text);
        return;
      }
      useStore.getState().setInterimTranscript(transcript.speaker, '');
      finalBuffers[transcript.speaker] = mergeFinalTranscript(finalBuffers[transcript.speaker], text);
      if (finalTimers[transcript.speaker] !== null) window.clearTimeout(finalTimers[transcript.speaker]!);
      finalTimers[transcript.speaker] = window.setTimeout(() => {
        const combined = finalBuffers[transcript.speaker];
        finalBuffers[transcript.speaker] = '';
        finalTimers[transcript.speaker] = null;
        commitFinalTranscript(transcript.speaker, combined);
      }, 250);
    };
    const start = async () => {
      useStore.getState().setCapture('starting');
      useStore.getState().setAudioSource('ME', { transcription: 'connecting' });
      useStore.getState().setAudioSource('THEM', { transcription: 'connecting' });
      const listeners = await Promise.all([
        onNativeTranscript(handleTranscript),
        onAudioLevel(level => { if (mounted) useStore.getState().setAudioSource(level.speaker, { level: Math.min(1, level.rms * 8), active: level.active }); }),
        onUsageUpdate(usage => { if (mounted) useStore.getState().setLiveUsage(usage.speaker, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }); }),
        onTranscriptionStatus(status => {
          if (!mounted) return;
          useStore.getState().setAudioSource(
            status.speaker,
            status.error
              ? { transcription: 'error', error: status.error }
              : { transcription: status.state || 'connected', error: undefined },
          );
        }),
        onAudioDeviceChanged(change => {
          if (!mounted) return;
          useStore.getState().setAudioSource('ME', { device: change.microphoneName });
          useStore.getState().setAudioSource('THEM', { device: change.loopbackName });
        }),
      ]);
      if (!mounted) {
        listeners.forEach(cleanup => cleanup());
        return;
      }
      cleanups.push(...listeners);
      if (sessionId) await startNativeSession(sessionId);
      if (!mounted) return;
      const devicePreference = loadAudioDevicePreference();
      const status = await startAudioCapture(devicePreference.micName, devicePreference.loopbackName);
      if (!mounted) return;
      applyCaptureStatus(status);
      if (!(await checkSystem()).apiConfigured) {
        const patch = { transcription: 'offline' as const, error: 'Conecta Gemini para activar la transcripción.' };
        useStore.getState().setAudioSource('ME', patch);
        useStore.getState().setAudioSource('THEM', patch);
      }
    };
    start().catch(error => { if (mounted) useStore.getState().setCapture('error', error instanceof Error ? error.message : String(error)); });
    return () => {
      mounted = false;
      answerGeneration += 1;
      for (const speaker of ['ME', 'THEM'] as const) {
        if (finalTimers[speaker] !== null) window.clearTimeout(finalTimers[speaker]!);
      }
      cleanups.forEach(cleanup => cleanup());
      useStore.getState().setCapture('stopped');
      void stopAudioCapture();
    };
  }, [sessionId]);
  return null;
}

function applyCaptureStatus(status: CaptureStatus) {
  const store = useStore.getState();
  store.setAudioSource('ME', { device: status.microphone_name || 'Micrófono predeterminado' });
  store.setAudioSource('THEM', { device: status.loopback_name || 'Salida de audio predeterminada' });
  store.setCapture(status.running ? 'listening' : 'error', status.error);
}

const WORDS_PER_MINUTE = 130;

function estimatedSlideSeconds(scriptEn: string): number {
  const words = scriptEn.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(8, Math.round((words / WORDS_PER_MINUTE) * 60));
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function useTeleprompter(slidePages: string[], slideScripts: SlideScriptEntry[], introScript: SlideScriptEntry | null, outroScript: SlideScriptEntry | null, currentSlideIndex: number, setCurrentSlideIndex: (index: number) => void, phase: PresentationPhase, setPhase: (phase: PresentationPhase) => void, onFinishPresentation: () => void) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const current = phase === 'intro' ? introScript : phase === 'outro' ? outroScript : slideScripts[currentSlideIndex];
  const budgetSeconds = current ? estimatedSlideSeconds(current.scriptEn) : 0;
  const overBudget = Boolean(current) && elapsedSeconds > budgetSeconds;
  const onLastSlide = currentSlideIndex >= slidePages.length - 1;

  useEffect(() => {
    setElapsedSeconds(0);
    const timer = window.setInterval(() => setElapsedSeconds(seconds => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [currentSlideIndex, phase]);

  const goTo = (index: number) => { setCurrentSlideIndex(index); void setSlideIndex(index); };
  const goNext = () => {
    if (phase === 'intro') { setPhase('slides'); return; }
    if (phase === 'outro') { onFinishPresentation(); return; }
    if (onLastSlide) { setPhase('outro'); return; }
    goTo(currentSlideIndex + 1);
  };
  const goBack = () => {
    if (phase === 'outro') { setPhase('slides'); return; }
    if (phase === 'slides') {
      if (currentSlideIndex === 0) { setPhase('intro'); return; }
      goTo(currentSlideIndex - 1);
    }
  };
  const headLabel = phase === 'intro' ? 'Saludo inicial' : phase === 'outro' ? 'Cierre' : `Diapositiva ${currentSlideIndex + 1} / ${slidePages.length}`;
  const nextLabel = phase === 'intro' ? 'Empezar diapositiva 1' : phase === 'outro' ? 'Pasar a preguntas' : onLastSlide ? 'Ir al cierre' : 'Siguiente';

  return { current, budgetSeconds, elapsedSeconds, overBudget, headLabel, nextLabel, goNext, goBack };
}

function SlideThumbnail({ bytes, pageNumber }: { bytes: Uint8Array | null; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    docRef.current = null;
    setReady(false);
    if (!bytes || !bytes.length) return;
    void loadPdf(bytes).then(doc => { if (!cancelled) { docRef.current = doc; setReady(true); } }).catch(() => setReady(false));
    return () => { cancelled = true; };
  }, [bytes]);

  useEffect(() => {
    if (!ready || !docRef.current || !canvasRef.current) return;
    const page = Math.min(Math.max(pageNumber, 1), docRef.current.numPages);
    void renderPdfPage(docRef.current, page, canvasRef.current, 400, 240);
  }, [ready, pageNumber]);

  return <div className="mt-4 aspect-[16/9] rounded-xl bg-slate-900 overflow-hidden flex items-center justify-center">
    {ready ? <canvas ref={canvasRef} className="max-w-full max-h-full" /> : <span className="text-xs text-slate-400">Sin vista previa</span>}
  </div>;
}

function AudioSourceCard({ label, source, enabled, disabled, onToggle }: { label: string; source: AudioSourceState; enabled: boolean; disabled: boolean; onToggle: () => void }) {
  const status = !enabled ? 'Detenido' : source.transcription === 'connecting' ? 'Conectando…' : source.transcription === 'error' ? 'Error' : source.transcription === 'offline' ? 'Sin conexión' : source.active ? 'Recibiendo audio' : 'Listo';
  const weights = [10, 18, 25, 14, 29, 20, 12, 26, 18, 30, 16, 22];
  return <div className={`rounded-2xl border bg-white p-4 ${enabled && source.active ? 'border-emerald-200' : 'border-slate-200'}`} title={source.device}>
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0"><div className="text-sm font-semibold text-slate-900">{label}</div><div className="text-xs text-slate-400 mt-1 truncate">{source.device}</div></div>
      <span className={`text-xs px-2 py-1 rounded-full shrink-0 ${enabled && source.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{status}</span>
    </div>
    <div className="meter h-8 mt-4">
      {weights.map((weight, index) => <span key={index} style={{ height: `${enabled ? Math.max(3, (weight / 30) * source.level * 32) : 3}px` }} />)}
    </div>
    <button onClick={onToggle} disabled={disabled} className="mt-3 w-full rounded-lg border border-slate-200 py-2 text-xs font-semibold disabled:opacity-50 flex items-center justify-center gap-1">{enabled ? <><Pause className="w-3.5 h-3.5" /> Silenciar</> : <><Play className="w-3.5 h-3.5" /> Activar</>}</button>
  </div>;
}

function TranscriptPanel({ turns, interimTranscripts, transcriptOpen, setTranscriptOpen, transcriptRef, exportTranscript }: { turns: Turn[]; interimTranscripts: Record<'ME' | 'THEM', string>; transcriptOpen: boolean; setTranscriptOpen: (open: boolean) => void; transcriptRef: React.RefObject<HTMLDivElement>; exportTranscript: () => void }) {
  return <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
    <button onClick={() => setTranscriptOpen(!transcriptOpen)} className="w-full px-5 py-4 flex items-center justify-between">
      <div className="flex items-center gap-2 font-bold text-slate-900"><Captions className="w-5 h-5" /> Transcripción en vivo</div>
      {transcriptOpen ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
    </button>
    {transcriptOpen && <div ref={transcriptRef} className="border-t border-slate-100 p-5 space-y-4 max-h-[360px] overflow-y-auto">
      {interimTranscripts.ME && <InterimTurn speaker="ME" text={interimTranscripts.ME} />}
      {interimTranscripts.THEM && <InterimTurn speaker="THEM" text={interimTranscripts.THEM} />}
      {turns.slice().reverse().map(turn => <TurnBubble key={turn.id} turn={turn} />)}
      {!turns.length && !interimTranscripts.ME && !interimTranscripts.THEM && <p className="text-sm text-slate-400">Aquí aparecerán el audio transcrito y su traducción.</p>}
      <button onClick={exportTranscript} disabled={!turns.length} className="flex items-center gap-2 text-xs text-slate-500 border border-slate-200 rounded-lg px-3 py-2 disabled:opacity-50"><FileText className="w-3.5 h-3.5" /> Exportar transcripción</button>
    </div>}
  </div>;
}

function TurnBubble({ turn }: { turn: Turn }) {
  return <div className={`flex gap-3 border-l-[3px] pl-3 ${turn.speaker === 'ME' ? 'border-emerald-400' : 'border-blue-400'}`}>
    <span className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold ${turn.speaker === 'ME' ? 'bg-slate-900 text-white' : 'bg-blue-50 text-blue-700'}`}>{turn.speaker === 'ME' ? 'Tú' : <Volume2 className="w-4 h-4" />}</span>
    <div className="min-w-0">
      <div className="text-xs text-slate-400">{turn.speaker === 'ME' ? 'Tú' : 'Computador'} · {turn.time}</div>
      <p className="text-sm mt-1 text-slate-900">{turn.text}</p>
      {turn.translation ? <p className="text-xs text-slate-500 mt-1">{turn.translation}</p> : turn.translating ? <p className="text-xs text-slate-400 mt-1">Traduciendo…</p> : <p className="text-xs text-red-500 mt-1">Traducción no disponible</p>}
    </div>
  </div>;
}

function InterimTurn({ speaker, text }: { speaker: 'ME' | 'THEM'; text: string }) {
  return <div className="flex gap-3 opacity-70">
    <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold bg-slate-100 text-slate-500">…</span>
    <div><div className="text-xs text-slate-400">{speaker === 'ME' ? 'Tú' : 'Computador'} · transcribiendo…</div><p className="text-sm mt-1 text-slate-500">{text}</p></div>
  </div>;
}

function Live() {
  const { answer, answerLoading, answerError, activeQuestion, questionQueue, turns, interimTranscripts, paused, setPaused, setAnswerText, removeQueuedQuestion, endLive, capturePhase, captureError, audioSources, sessionId, sessionTitle, sessionMode, slidePages, slideScripts, introScript, outroScript, currentSlideIndex, setCurrentSlideIndex, presentationPhase, setPresentationPhase, presentationFinished, setPresentationFinished, presentationPdfBytes, liveElapsedSeconds } = useStore();
  const [sourceEnabled, setSourceEnabled] = useState<Record<'ME' | 'THEM', boolean>>({ ME: true, THEM: true });
  const [sourceBusy, setSourceBusy] = useState<'ME' | 'THEM' | null>(null);
  const [variantBusy, setVariantBusy] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [presenterOpen, setPresenterOpen] = useState(true);
  const [reopening, setReopening] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const tp = useTeleprompter(slidePages, slideScripts, introScript, outroScript, currentSlideIndex, setCurrentSlideIndex, presentationPhase, setPresentationPhase, () => setPresentationFinished(true));

  useEffect(() => {
    if (sessionMode !== 'presentation') return;
    let mounted = true;
    const cleanup = onPresenterClosed(() => { if (mounted) setPresenterOpen(false); });
    return () => { mounted = false; void cleanup.then(unlisten => unlisten()); };
  }, [sessionMode]);
  const reopenPresenter = async () => {
    if (!presentationPdfBytes) return;
    setReopening(true);
    try {
      await setPresentationPdf(presentationPdfBytes);
      await openPresenterWindow(useStore.getState().presentationMonitorIndex);
      setPresenterOpen(true);
    } finally {
      setReopening(false);
    }
  };
  const restartPresentation = () => {
    setCurrentSlideIndex(0);
    void setSlideIndex(0);
    setPresentationFinished(false);
    setPresentationPhase('intro');
  };
  const needsApiKey = audioSources.ME.transcription === 'offline' || audioSources.THEM.transcription === 'offline';
  const transcriptionError = audioSources.ME.error || audioSources.THEM.error;
  const toggleListening = async () => {
    if (paused) {
      useStore.getState().setCapture('starting');
      const devicePreference = loadAudioDevicePreference();
      const status = await startAudioCapture(devicePreference.micName, devicePreference.loopbackName);
      applyCaptureStatus(status);
      if (status.running) {
        await Promise.all((['ME', 'THEM'] as const).filter(speaker => !sourceEnabled[speaker]).map(speaker => setAudioSourceEnabled(speaker, false)));
        setPaused(false);
      }
    } else {
      await stopAudioCapture();
      setPaused(true);
      useStore.getState().setCapture('paused');
      useStore.getState().setAudioSource('ME', { level: 0, active: false });
      useStore.getState().setAudioSource('THEM', { level: 0, active: false });
    }
  };
  const toggleSource = async (speaker: 'ME' | 'THEM') => {
    const enabled = !sourceEnabled[speaker];
    setSourceBusy(speaker);
    try {
      await setAudioSourceEnabled(speaker, enabled);
      setSourceEnabled(current => ({ ...current, [speaker]: enabled }));
      if (!enabled) {
        useStore.getState().setAudioSource(speaker, { level: 0, active: false });
        useStore.getState().setInterimTranscript(speaker, '');
      }
    } finally {
      setSourceBusy(null);
    }
  };
  useEffect(() => {
    if (sessionId && turns.length) localStorage.setItem(`voxa:transcript:${sessionId}`, JSON.stringify(turns));
  }, [sessionId, turns]);
  useEffect(() => {
    if (transcriptOpen) transcriptRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [transcriptOpen, turns.length]);
  const exportTranscript = () => {
    const lines = turns.map(turn => `${turn.time} · ${turn.speaker === 'ME' ? 'Tú' : 'Computador'}\n${turn.text}${turn.translation ? `\n${turn.translation}` : ''}`);
    if (answer) lines.push(`\nRespuesta actual\n${answer.answer}`);
    const blob = new Blob([`${sessionTitle}\n\n${lines.join('\n\n')}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${sessionTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'voxa-session'}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const showNextQuestion = () => {
    const next = questionQueue[0];
    if (!next || answerLoading) return;
    useStore.getState().removeFirstQueuedQuestion();
    void answerDetectedQuestion(next);
  };
  const runVariant = async (kind: 'shorter' | 'more' | 'alternative') => {
    if (!answer || variantBusy) return;
    const questionAtStart = answer.questionEn;
    setVariantBusy(true);
    try {
      const conversation = useStore.getState().turns.slice(-24).map(turn => `[${turn.speaker}] ${turn.text}`).join('\n');
      const variant = await generateAnswerVariant(kind, answer.questionEn, answer.answer, conversation);
      if (variant && useStore.getState().answer?.questionEn === questionAtStart) {
        setAnswerText(variant.answer);
        useStore.getState().addAnswerCost(answerCost(variant));
      }
    } catch (error) {
      console.error('No se pudo generar la variante de respuesta', error);
    } finally {
      setVariantBusy(false);
    }
  };
  useEffect(() => {
    const toggle = () => { void toggleListening(); };
    const variant = (event: Event) => { void runVariant((event as CustomEvent<'shorter' | 'more' | 'alternative'>).detail); };
    window.addEventListener('voxa-toggle-listening', toggle);
    window.addEventListener('voxa-answer-variant', variant);
    return () => {
      window.removeEventListener('voxa-toggle-listening', toggle);
      window.removeEventListener('voxa-answer-variant', variant);
    };
  });
  const finishLive = () => { answerGeneration += 1; void stopNativeSession(); if (sessionMode === 'presentation') void closePresenterWindow(); endLive(); };

  const alertBanner = (captureError || transcriptionError || needsApiKey) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-center gap-3 text-sm text-amber-800">
    <AlertTriangle className="w-5 h-5 shrink-0" />
    <span className="flex-1"><strong>{captureError ? 'No se pudo iniciar la captura.' : transcriptionError ? 'La transcripción no está disponible.' : 'Gemini todavía no está conectado.'}</strong> {captureError || transcriptionError || 'Puedes conectar Gemini desde Configuración y reintentar sin perder esta sesión.'}</span>
    {needsApiKey ? <button onClick={() => window.dispatchEvent(new Event('voxa-open-settings'))} className="font-semibold underline shrink-0">Abrir Gemini</button> : <button onClick={() => void toggleListening()} className="font-semibold underline shrink-0">Reintentar audio</button>}
  </div>;

  return <>
    <div className="flex items-center justify-end gap-3 mb-5">
      {questionQueue.length > 0 && <span className="text-xs bg-blue-50 text-blue-700 px-2.5 py-1.5 rounded-full font-semibold">{questionQueue.length} en cola</span>}
      <button onClick={() => void toggleListening()} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold flex items-center gap-2 hover:bg-slate-50">{paused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}{paused ? 'Reanudar' : 'Pausar'} <span className="text-xs text-slate-400">Espacio</span></button>
      <button onClick={() => setConfirmEnd(true)} className="rounded-xl bg-red-50 text-red-700 px-4 py-2 text-sm font-semibold hover:bg-red-100">Terminar sesión</button>
    </div>

    {sessionMode === 'presentation' ? <div className="grid 2xl:grid-cols-[300px_1fr_420px] xl:grid-cols-[280px_1fr] gap-4">
      <aside className="space-y-4">
        <div className="rounded-2xl bg-slate-900 text-white p-5">
          <p className="text-xs uppercase tracking-[.16em] text-slate-400">Presentación activa</p>
          <div className="mt-2 flex items-end justify-between"><span className="text-3xl font-mono">{formatSeconds(tp.elapsedSeconds)}</span><span className="text-xs text-slate-400">de ~{formatSeconds(tp.budgetSeconds)}</span></div>
          <div className="mt-4 h-1.5 bg-white/10 rounded-full overflow-hidden"><div className="h-full bg-blue-500" style={{ width: `${tp.budgetSeconds ? Math.min(100, (tp.elapsedSeconds / tp.budgetSeconds) * 100) : 0}%` }} /></div>
        </div>
        {!presentationFinished && slidePages.length > 0 && <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex justify-between text-sm"><span className="font-semibold text-slate-900">{tp.headLabel}</span></div>
          <SlideThumbnail bytes={presentationPdfBytes} pageNumber={presentationPhase === 'slides' ? currentSlideIndex + 1 : 1} />
          <div className="grid grid-cols-2 gap-2 mt-3">
            <button onClick={tp.goBack} disabled={presentationPhase === 'intro'} className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-semibold disabled:opacity-40">← Anterior</button>
            <button onClick={tp.goNext} className="px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold">{tp.nextLabel} →</button>
          </div>
        </div>}
        <AudioSourceCard label="Micrófono" source={audioSources.ME} enabled={sourceEnabled.ME} disabled={paused || sourceBusy !== null} onToggle={() => void toggleSource('ME')} />
        {!presenterOpen && <button onClick={() => void reopenPresenter()} disabled={reopening} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold flex items-center justify-center gap-2 hover:bg-slate-50 disabled:opacity-50"><MonitorUp className="w-4 h-4" /> {reopening ? 'Abriendo…' : 'Reabrir pantalla pública'}</button>}
        {slidePages.length > 0 && <button onClick={restartPresentation} className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold flex items-center justify-center gap-2 hover:bg-slate-50"><RotateCcw className="w-4 h-4" /> Reiniciar guion</button>}
      </aside>

      <section className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <p className="text-xs uppercase tracking-[.16em] text-violet-600 font-semibold">Teleprompter · {tp.headLabel}</p>
            {tp.current && <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${tp.overBudget ? 'bg-amber-50 text-amber-700' : 'bg-violet-50 text-violet-700'}`}>{formatSeconds(tp.elapsedSeconds)} / ~{formatSeconds(tp.budgetSeconds)}</span>}
          </div>
          {tp.current ? <>
            <p className="mt-6 text-lg text-blue-700 font-medium leading-8">{tp.current.scriptEn}</p>
            <div className="mt-4 rounded-2xl bg-slate-900 text-white p-7"><p className="text-2xl leading-10 font-semibold">{tp.current.pronunciation}</p></div>
            <p className="mt-4 text-sm text-slate-500 leading-6">{tp.current.scriptEs}</p>
          </> : <p className="mt-6 text-slate-400">Generando guion…</p>}
          <div className="mt-5 pt-5 border-t border-slate-100 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-400">Esc en la pantalla pública para salir de pantalla completa.</div>
            <div className="flex gap-2"><span className="kbd">Ctrl ⇧ S</span><span className="kbd">Ctrl ⇧ M</span><span className="kbd">Ctrl ⇧ A</span></div>
          </div>
        </div>
        {alertBanner}
      </section>

      <aside className="space-y-4 2xl:block hidden">
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex justify-between items-center"><h3 className="font-bold text-slate-900">Preguntas en cola</h3><span className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-full font-semibold">{questionQueue.length}</span></div>
          {answer && <div className="mt-4 p-4 rounded-xl bg-blue-50 border border-blue-100"><div className="text-xs text-blue-600 font-semibold">Actual</div><p className="mt-2 text-sm font-medium text-slate-900">{answer.questionEn}</p></div>}
          {questionQueue.map(question => <div key={question} className="mt-3 p-4 rounded-xl border border-slate-200"><p className="text-sm text-slate-600">{question}</p></div>)}
          {!answer && !questionQueue.length && <p className="mt-4 text-sm text-slate-400">Sin preguntas por ahora.</p>}
        </div>
        <TranscriptPanel turns={turns} interimTranscripts={interimTranscripts} transcriptOpen={transcriptOpen} setTranscriptOpen={setTranscriptOpen} transcriptRef={transcriptRef} exportTranscript={exportTranscript} />
      </aside>
    </div> : <div className="grid xl:grid-cols-[320px_1fr] gap-5">
      <aside className="space-y-4">
        <div className="rounded-2xl bg-slate-900 text-white p-5">
          <div className="flex items-center justify-between">
            <div><div className="text-xs uppercase tracking-[.16em] text-slate-400">Sesión activa</div><div className="font-bold mt-1">{sessionModeLabel[sessionMode]}</div></div>
            <span className={`w-3 h-3 rounded-full ${capturePhase === 'error' ? 'bg-red-500' : paused ? 'bg-slate-500' : 'bg-red-500 animate-pulse'}`} />
          </div>
          <div className="text-3xl font-mono mt-5">{formatHms(liveElapsedSeconds)}</div>
          <div className="mt-4 text-sm text-slate-400">{sessionTitle}</div>
        </div>
        <AudioSourceCard label="Tú" source={audioSources.ME} enabled={sourceEnabled.ME} disabled={paused || sourceBusy !== null} onToggle={() => void toggleSource('ME')} />
        <AudioSourceCard label="Computador" source={audioSources.THEM} enabled={sourceEnabled.THEM} disabled={paused || sourceBusy !== null} onToggle={() => void toggleSource('THEM')} />
      </aside>
      <section className="space-y-4">
        {sessionMode !== 'reunion' ? <div className="rounded-2xl border border-slate-200 bg-white overflow-hidden">
          {answer ? <>
            <div className="p-5 border-b border-slate-100 flex items-start justify-between gap-4">
              <div><p className="text-xs uppercase tracking-[.16em] font-semibold text-blue-600">Te preguntaron</p><h2 className="mt-2 text-xl font-bold text-slate-900">{answer.questionEn}</h2><p className="text-sm text-slate-500 mt-1">{answer.questionEs}</p></div>
              <span className={`px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${answer.confidence === 'HIGH' ? 'bg-emerald-50 text-emerald-700' : answer.confidence === 'MEDIUM' ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{answer.confidence === 'HIGH' ? 'Basado en tu contexto' : answer.confidence === 'MEDIUM' ? 'Revisa los detalles' : 'Falta información'}</span>
            </div>
            <div className="p-6">
              <div className="rounded-2xl bg-slate-900 text-white p-6">
                <span className="text-xs uppercase tracking-[.16em] text-slate-400">Respuesta recomendada</span>
                <p className="mt-3 text-xl leading-8">{answer.answer}</p>
                {answer.warning && <p className="mt-3 flex items-center gap-2 text-sm text-amber-300"><AlertTriangle className="w-4 h-4" />{answer.warning}</p>}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button disabled={variantBusy} onClick={() => void runVariant('shorter')} className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-semibold disabled:opacity-50 disabled:cursor-wait"><Minimize2 className="inline w-4 h-4 mr-1" /> Más corta</button>
                <button disabled={variantBusy} onClick={() => void runVariant('more')} className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-semibold disabled:opacity-50 disabled:cursor-wait"><AlignLeft className="inline w-4 h-4 mr-1" /> Más detalle</button>
                <button disabled={variantBusy} onClick={() => void runVariant('alternative')} className="px-3 py-2 rounded-lg border border-slate-200 text-sm font-semibold disabled:opacity-50 disabled:cursor-wait"><RefreshCw className="inline w-4 h-4 mr-1" /> Alternativa</button>
              </div>
              {questionQueue.length > 0 && <div className="mt-4 flex items-center justify-between gap-4 rounded-xl bg-blue-50 border border-blue-100 p-4">
                <div className="min-w-0"><strong className="text-sm text-blue-700">{questionQueue.length} {questionQueue.length === 1 ? 'pregunta adicional' : 'preguntas adicionales'}</strong><p className="text-sm text-slate-500 truncate">Siguiente: {questionQueue[0]}</p></div>
                <div className="flex items-center gap-3 shrink-0">
                  <button onClick={() => removeQueuedQuestion(questionQueue[0])} className="text-sm text-slate-500 font-semibold">Descartar</button>
                  <button onClick={showNextQuestion} className="text-sm text-blue-600 font-semibold flex items-center gap-1">Mostrar siguiente <ArrowRight className="w-3.5 h-3.5" /></button>
                </div>
              </div>}
            </div>
          </> : <div className="p-10 flex flex-col items-center text-center text-slate-500">
            <div className="w-14 h-14 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center mb-4"><Radio className="w-6 h-6" /></div>
            <h2 className="text-xl font-bold text-slate-900">{answerError ? 'Respuesta no disponible' : answerLoading ? 'Preparando tu respuesta' : paused ? 'La escucha está en pausa' : 'Esperando una pregunta'}</h2>
            <p className="mt-2 text-sm">{answerError || (answerLoading ? activeQuestion : paused ? 'Reanuda cuando estés listo.' : 'Habla o reproduce el audio de la reunión. Los medidores de la izquierda deben moverse.')}</p>
            {answerError && activeQuestion && <button onClick={() => void answerDetectedQuestion(activeQuestion)} className="mt-4 px-4 py-2.5 rounded-xl border border-slate-200 text-sm font-semibold">Intentar de nuevo</button>}
          </div>}
        </div> : <div className="rounded-2xl border border-slate-200 bg-white p-6">
          <p className="text-xs uppercase tracking-[.16em] font-semibold text-emerald-600">Modo reunión</p>
          <h2 className="mt-2 text-xl font-bold text-slate-900">Transcripción y traducción en vivo</h2>
          <p className="mt-2 text-sm text-slate-500">Voxa escucha y traduce automáticamente. Revisa la transcripción más abajo.</p>
        </div>}
        {alertBanner}
        <TranscriptPanel turns={turns} interimTranscripts={interimTranscripts} transcriptOpen={transcriptOpen} setTranscriptOpen={setTranscriptOpen} transcriptRef={transcriptRef} exportTranscript={exportTranscript} />
      </section>
    </div>}

    {confirmEnd && <ConfirmDialog title="¿Terminar la sesión?" message="Se detendrá la captura y podrás revisar un resumen. La transcripción disponible se conservará en este dispositivo." confirmLabel="Terminar sesión" danger onConfirm={finishLive} onCancel={() => setConfirmEnd(false)} />}
  </>;
}

export default App;
