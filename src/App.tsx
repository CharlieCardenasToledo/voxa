import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, ChevronDown, ChevronLeft, ChevronRight, FileText, Mic, Monitor as MonitorIcon, Pause, Play, Radio, RotateCcw, Settings2, ShieldCheck, Upload, Volume2 } from 'lucide-react';
import { useStore, type PresentationPhase, type Screen, type SessionMode, type SlideScriptEntry, type Turn } from './store';
import { analyzeTranscript, checkGeminiHealth, checkSystem, closePresenterWindow, deleteSession, extractDocument, generateAnswerVariant, generateCopilotAnswer, generateSlideScripts, getAppInfo, getUsageStats, getUserProfile, identifyMonitors, isNativeRuntime, listMonitors, loadPresentationPdf, loadSessions, onAudioDeviceChanged, onAudioLevel, onNativeTranscript, onPresenterClosed, onTranscriptionStatus, onUsageUpdate, openPresenterWindow, prepareNativeSession, resetUsageStats, restoreSession, savePresentationDeck, savePresentationPdf, saveUserProfile, setAudioSourceEnabled, setGeminiApiKey, setPresentationPdf, setSlideIndex, startAudioCapture, startNativeSession, stopAudioCapture, stopNativeSession, validateGeminiApiKey, type AppInfo, type CaptureStatus, type GeminiHealthReport, type MonitorInfo, type NativeCopilotAnswer, type PrepareSessionRequest, type SavedSession, type SystemCheck, type UsageStats, type UserProfile } from './services/native';
import { looksLikeQuestion, mergeFinalTranscript } from './services/transcript';

const screens: { id: Screen; label: string }[] = [
  { id: 'prepare', label: 'Preparar' },
  { id: 'practice', label: 'Practicar' },
  { id: 'live', label: 'En vivo' },
];

const audienceLabel = (audience: string) => ({
  'Engineering team': 'Equipo de ingeniería',
  Managers: 'Directivos',
  'Mixed audience': 'Audiencia mixta',
}[audience] || audience);

const sessionModeLabel: Record<SessionMode, string> = { class: 'Clase', presentation: 'Presentación', reunion: 'Reunión' };

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

  const systemReady = Boolean(system?.apiConfigured && (store.sessionMode === 'reunion' ? system.microphone || system.loopback : system.microphone && system.loopback));
  const isLive = store.screen === 'live';
  return <div className="app">
    <header className={`app-header ${isLive ? 'app-header-live' : ''}`}>
      <button className="wordmark" onClick={() => store.setScreen('prepare')} aria-label="Ir a Preparar">Voxa</button>
      {!isLive && <nav className="main-nav" aria-label="Navegación principal">
        {screens.map(({ id, label }) => { const skippedForReunion = id === 'practice' && store.sessionMode === 'reunion'; const unavailable = id !== 'prepare' && (!store.prepared || skippedForReunion); return <button key={id} className={store.screen === id ? 'active' : ''} disabled={unavailable} title={unavailable ? (skippedForReunion ? 'No aplica en modo Reunión' : 'Primero prepara una sesión') : undefined} onClick={() => store.setScreen(id)}>{label}</button>; })}
      </nav>}
      {isLive && <span className="live-mode-label"><Radio size={14} /> Sesión en vivo · {sessionModeLabel[store.sessionMode]}</span>}
      {!isLive && <div className="header-actions">
        {store.prepared && <button className="session-badge" onClick={() => store.setScreen('prepare')} title="Cambiar modo o preparar otra sesión"><span className={`mode-dot mode-${store.sessionMode}`} />{sessionModeLabel[store.sessionMode]} <small>{store.sessionTitle}</small></button>}
        <button className={`system-status ${systemReady ? 'ready' : 'attention'}`} onClick={!systemReady && isNativeRuntime() ? () => { setSettingsTab('account'); store.setScreen('settings'); } : undefined}>
          <i />{systemReady ? 'Listo' : isNativeRuntime() ? system?.apiConfigured ? 'Revisar audio' : 'Conectar Gemini' : 'Vista del navegador'}
        </button>
        <button className={`profile-button ${store.screen === 'settings' ? 'active' : ''}`} onClick={() => { setSettingsTab('profile'); store.setScreen('settings'); }} aria-label="Abrir perfil y configuración">{profile?.photoDataUrl ? <img src={profile.photoDataUrl} alt="" /> : <span>{profileInitials(profile?.name || '')}</span>}<Settings2 size={15} /></button>
      </div>}
    </header>
    <main className={`screen screen-${store.screen}`}>
      {store.screen === 'prepare' && <Prepare />}
      {store.screen === 'practice' && <Practice />}
      {store.screen === 'live' && <><LiveAudioBridge /><Live /></>}
      {store.screen === 'summary' && <SessionSummary />}
      {store.screen === 'settings' && <Settings initialTab={settingsTab} system={system} setSystem={setSystem} profile={profile} setProfile={setProfile} />}
    </main>
  </div>;
}

function SessionSummary() {
  const { sessionTitle, sessionMode, turns, answer, practiceQuestions, setScreen } = useStore();
  const themTurns = turns.filter(turn => turn.speaker === 'THEM');
  const exportSummary = () => {
    const body = turns.map(turn => `${turn.time} · ${turn.speaker === 'ME' ? 'Tú' : 'Computador'}\n${turn.text}${turn.translation ? `\n${turn.translation}` : ''}`).join('\n\n');
    const blob = new Blob([`${sessionTitle}\n\n${body || 'No hubo transcripción disponible.'}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = `${sessionTitle.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'voxa-session'}-resumen.txt`; link.click(); URL.revokeObjectURL(url);
  };
  return <div className="page summary-page">
    <div className="summary-hero">
      <span className="summary-mark"><ShieldCheck size={24} /></span>
      <div><p className="overline">Sesión terminada</p><h1>{sessionTitle}</h1><p className="supporting">Aquí tienes lo necesario para revisar la sesión y preparar la siguiente.</p></div>
    </div>
    <div className="summary-grid">
      <section className="card summary-card"><p className="overline">Actividad</p><dl><div><dt>Modalidad</dt><dd>{sessionModeLabel[sessionMode]}</dd></div><div><dt>Intervenciones transcritas</dt><dd>{turns.length}</dd></div><div><dt>Preguntas escuchadas</dt><dd>{themTurns.length}</dd></div><div><dt>Preguntas preparadas</dt><dd>{practiceQuestions.length || '—'}</dd></div></dl></section>
      <section className="card summary-card"><p className="overline">Siguiente paso</p><h2>{answer ? 'Revisa la última respuesta' : 'Prepara otra sesión'}</h2><p className="supporting">Puedes volver al guion, ajustar el contexto o comenzar una nueva sesión con el mismo modo.</p><div className="summary-actions"><button className="primary-button" onClick={() => setScreen('prepare')}>Preparar otra sesión <ArrowRight size={16} /></button><button className="secondary-button" onClick={() => setScreen('practice')}>Revisar práctica</button></div></section>
    </div>
    <button className="export-button summary-export" onClick={exportSummary}><FileText size={14} /> Exportar transcripción</button>
  </div>;
}

type SettingsTab = 'account' | 'profile' | 'usage' | 'diagnostics';

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
  }, []);

  const tabs: { id: SettingsTab; label: string }[] = [
    { id: 'profile', label: 'Perfil' },
    { id: 'account', label: 'Gemini y aplicación' },
    { id: 'usage', label: 'Uso' },
    { id: 'diagnostics', label: 'Diagnóstico' },
  ];

  return <div className="page settings-page">
    <div className="page-heading compact-heading">
      <button className="secondary-button back-button" onClick={() => { const back = useStore.getState().previousScreen; useStore.getState().setScreen(back === 'settings' ? 'prepare' : back); }}><ChevronLeft size={15} /> Volver</button>
      <p className="overline">Tu espacio</p>
      <h1>Perfil y configuración</h1>
      <p>Administra cómo te reconoce Voxa y cómo funciona la aplicación.</p>
    </div>
    <div className="settings-shell">
      <aside className="settings-sidebar">
        <div className="settings-user"><div className="settings-user-avatar">{profilePhoto ? <img src={profilePhoto} alt="" /> : <span>{profileInitials(profileName)}</span>}</div><div><strong>{profileName.trim() || 'Tu perfil'}</strong><small>{profileContext.trim() ? 'Contexto personalizado' : 'Completa tus datos'}</small></div></div>
        <nav className="settings-tabs" aria-label="Perfil y configuración">
          {tabs.map(({ id, label }) => <button key={id} type="button" className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
      </aside>
      <section className="card prepare-card settings-content">
      {tab === 'account' && <>
        <div className={`credential-status ${system?.apiConfigured ? 'configured' : 'missing'}`}><ShieldCheck size={20} /><div><strong>{system?.apiConfigured ? 'Token de Gemini configurado' : 'Falta conectar Gemini'}</strong><span>{system?.apiConfigured ? 'La credencial está guardada de forma segura en Windows. Por seguridad, Voxa nunca vuelve a mostrar su contenido.' : 'Añade una clave API para activar la transcripción y las respuestas.'}</span></div></div>
        {!system?.apiConfigured && <ol className="settings-guide"><li><strong>1</strong><span>Pega tu clave API.</span></li><li><strong>2</strong><span>Voxa comprobará que funciona.</span></li><li><strong>3</strong><span>La guardará en el Administrador de credenciales de Windows.</span></li></ol>}
        <label>{system?.apiConfigured ? 'Reemplazar token' : 'Clave API de Gemini'}<input aria-label="Clave API de Gemini" type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setKeyMessage(''); }} placeholder={system?.apiConfigured ? '••••••••••••••••  Token guardado' : 'Pega aquí tu clave'} /><small className="field-hint">{system?.apiConfigured ? 'Escribe una nueva clave únicamente si quieres sustituir la actual.' : 'La clave no se almacena dentro de los archivos de Voxa.'}</small></label>
        {keyMessage && <p className="form-message" role="status">{keyMessage}</p>}
        <div className="modal-actions">
          <button className="primary-button" disabled={!apiKey.trim() || savingKey} onClick={async () => {
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
        </div>
        <div className="config-summary">
          <p className="overline">Configuración de la app</p>
          <dl>
            <div><dt>Versión</dt><dd>{appInfo?.version || '—'}</dd></div>
            <div><dt>Modelo principal</dt><dd>{appInfo?.primaryModel || '—'}</dd></div>
            <div><dt>Modelo de respaldo</dt><dd>{appInfo?.fallbackModels?.join(', ') || '—'}</dd></div>
            <div><dt>Micrófono</dt><dd>{system?.microphone ? 'Detectado' : 'No detectado'}</dd></div>
            <div><dt>Audio del sistema</dt><dd>{system?.loopback ? 'Detectado' : 'No detectado'}</dd></div>
            <div><dt>Clave de Gemini</dt><dd>{system?.apiConfigured ? 'Configurada' : 'Falta configurar'}</dd></div>
            <div><dt>Datos guardados en</dt><dd className="config-path">{appInfo?.dataDir || '—'}</dd></div>
          </dl>
        </div>
      </>}
      {tab === 'profile' && <div className="profile-section no-border">
        <div className="profile-identity">
          <div className="profile-photo" aria-label="Foto de perfil">{profilePhoto ? <img src={profilePhoto} alt="Foto de perfil" /> : <span>{profileInitials(profileName)}</span>}</div>
          <div className="profile-identity-copy"><p className="overline">Tu perfil</p><h2>{profileName.trim() || 'Completa tu identidad'}</h2><p>Voxa usa estos datos para adaptar el tono, el vocabulario y el nivel de tus respuestas.</p><div className="profile-photo-actions"><label className="secondary-button photo-upload">{profilePhoto ? 'Cambiar foto' : 'Añadir foto'}<input type="file" accept="image/jpeg,image/png,image/webp" aria-label="Seleccionar foto de perfil" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; setPhotoError(''); try { setProfilePhoto(await prepareProfilePhoto(file)); } catch (cause) { setPhotoError(cause instanceof Error ? cause.message : 'No se pudo usar la imagen.'); } finally { event.target.value = ''; } }} /></label>{profilePhoto && <button className="profile-remove-photo" type="button" onClick={() => { setProfilePhoto(''); setPhotoError(''); }}>Quitar</button>}</div></div>
        </div>
        {photoError && <p className="form-error"><AlertTriangle size={16} />{photoError}</p>}
        <div className="profile-form-divider" />
        <label>Nombre visible<input aria-label="Tu nombre" value={profileName} onChange={event => { setProfileName(event.target.value); setProfileMessage(''); }} placeholder="¿Cómo quieres que te llame Voxa?" /></label>
        <label>Contexto profesional<textarea aria-label="Tu contexto profesional" value={profileContext} onChange={event => { setProfileContext(event.target.value); setProfileMessage(''); }} placeholder="Tu función, empresa, equipo y tipo de trabajo habitual" /><small className="field-hint">Este contexto se aplica a todas las sesiones; el contexto específico se añade al preparar cada una.</small></label>
        <label>Vocabulario que Voxa debe recordar<textarea aria-label="Vocabulario técnico habitual" value={profileVocabulary} onChange={event => { setProfileVocabulary(event.target.value); setProfileMessage(''); }} placeholder="Productos, siglas, tecnologías y nombres propios, separados por comas" /></label>
        <div className="profile-privacy"><ShieldCheck size={17} /><span><strong>Perfil local</strong> La foto permanece en este dispositivo y no se incluye en las solicitudes a Gemini.</span></div>
        {profileMessage && <p className="form-message" role="status">{profileMessage}</p>}
        <button className="primary-button profile-save" disabled={profileSaving || !profileName.trim()} onClick={async () => {
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
      {tab === 'usage' && <div className="usage-summary no-border">
        <div className="usage-head">
          <p className="overline">Uso y gasto acumulado</p>
          <button className="secondary-button" onClick={() => setConfirmingReset(true)}>Reiniciar contador</button>
        </div>
        <dl>
          <div><dt>Gasto estimado (histórico)</dt><dd>$ {(usageStats?.totalCostUsd || 0).toFixed(4)}</dd></div>
          <div><dt>Llamadas a Gemini</dt><dd>{usageStats?.totalCalls || 0}</dd></div>
          <div><dt>Tokens (entrada / salida)</dt><dd>{(usageStats?.totalInputTokens || 0).toLocaleString()} / {(usageStats?.totalOutputTokens || 0).toLocaleString()}</dd></div>
        </dl>
        <small className="document-privacy">Este total acumula todas las sesiones desde que se instaló (o desde el último reinicio del contador); es independiente del costo estimado que ves durante una sesión En vivo.</small>
      </div>}
      {tab === 'diagnostics' && <div className="health-panel no-border">
        <div className="health-head">
          <p className="overline">Estado de Gemini</p>
          <button className="secondary-button" onClick={runHealthCheck} disabled={healthLoading}>{healthLoading ? 'Comprobando…' : 'Ejecutar diagnóstico'}</button>
        </div>
        {health && <ul className="health-list">
          {health.checks.map(check => <li key={check.id} className={check.ok ? 'ok' : 'fail'}>
            <i />
            <div><strong>{check.label}</strong><span>{check.message}</span></div>
            {check.latencyMs > 0 && <small>{check.latencyMs} ms</small>}
          </li>)}
        </ul>}
      </div>}
      </section>
    </div>
    {confirmingReset && <ConfirmDialog title="Reiniciar contador de gasto" message="Esto borra el historial acumulado de gasto en Gemini (costo, llamadas y tokens desde siempre). No se puede deshacer." confirmLabel="Reiniciar" danger busy={usageResetting} onConfirm={() => void confirmResetUsage()} onCancel={() => setConfirmingReset(false)} />}
  </div>;
}

function ConfirmDialog({ title, message, confirmLabel, danger, busy, onConfirm, onCancel }: { title: string; message: string; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return <div className="modal-backdrop" onClick={onCancel}>
    <section className="settings-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={event => event.stopPropagation()}>
      <div className="modal-head"><div><h2 id="confirm-title">{title}</h2></div></div>
      <p className="supporting">{message}</p>
      <div className="modal-actions">
        <button className="secondary-button" onClick={onCancel} disabled={busy}>Cancelar</button>
        <button className={danger ? 'end-button' : 'primary-button'} onClick={onConfirm} disabled={busy}>{busy ? 'Un momento…' : confirmLabel}</button>
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

  return <div className="modal-backdrop">
    <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="modal-head"><div><p className="overline">Bienvenido a Voxa</p><h2 id="onboarding-title">Cuéntale a Voxa sobre ti</h2></div></div>
      <p className="supporting">Esto ayuda al copiloto a personalizar sus respuestas y a recordar tu vocabulario técnico entre sesiones. Puedes editarlo luego desde Configuración.</p>
      <label>Tu nombre<input aria-label="Tu nombre" value={name} onChange={event => setName(event.target.value)} placeholder="Ej.: Charlie Cárdenas" autoFocus /></label>
      <label>Tu contexto profesional<textarea aria-label="Tu contexto profesional" value={professionalContext} onChange={event => setProfessionalContext(event.target.value)} placeholder="Empresa, equipo o rol habitual" /></label>
      <label>Vocabulario técnico que usas seguido<textarea aria-label="Vocabulario técnico habitual" value={vocabulary} onChange={event => setVocabulary(event.target.value)} placeholder="Nombres de producto, siglas, tecnologías (opcional)" /></label>
      {error && <p className="form-error"><AlertTriangle size={16} />{error}</p>}
      <div className="modal-actions">
        <button className="secondary-button" disabled={saving} onClick={() => void finish(true)}>Omitir por ahora</button>
        <button className="primary-button" disabled={saving || !name.trim()} onClick={() => void finish(false)}>{saving ? 'Guardando…' : 'Empezar a usar Voxa'}</button>
      </div>
    </section>
  </div>;
}

function Prepare() {
  const { prepare, setSessionTitle, setSessionId, setPracticeQuestions, sessionMode, setSessionMode, setSlideDeck, setPresentationPdfBytes } = useStore();
  const title = useStore(state => state.sessionTitle);
  const [file, setFile] = useState<File | null>(null);
  const [vocabulary, setVocabulary] = useState('');
  const [role, setRole] = useState('Desarrollador de software');
  const [audience, setAudience] = useState('Engineering team');
  const [level, setLevel] = useState('B2');
  const [responseLength, setResponseLength] = useState('Short');
  const [importantFacts, setImportantFacts] = useState('');
  const [forbiddenClaims, setForbiddenClaims] = useState('');
  const [context, setContext] = useState('');
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [restoring, setRestoring] = useState(false);
  useEffect(() => { loadSessions().then(setSavedSessions).catch(() => setSavedSessions([])); }, []);
  const [preparing, setPreparing] = useState(false);
  const [prepareStep, setPrepareStep] = useState('');
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SavedSession | null>(null);
  const [deleting, setDeleting] = useState(false);
  const prepareGenerationRef = useRef(0);

  const cancelPreparing = () => {
    prepareGenerationRef.current += 1;
    setPreparing(false);
    setPrepareStep('');
    setError('Preparación cancelada.');
  };

  const prepareClick = async () => {
    const generation = ++prepareGenerationRef.current;
    setPreparing(true); setError(''); setPrepareStep('');
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
      prepare(title);
      if (sessionMode === 'reunion') {
        // Nothing to rehearse when you're not presenting - skip Practicar
        // and go straight to the live transcription/translation view.
        useStore.getState().startLive(false);
        useStore.getState().setScreen('live');
      }
    } catch (cause) {
      if (generation !== prepareGenerationRef.current) return;
      setError(cause instanceof Error ? cause.message : 'No se pudo preparar la sesión.');
    } finally {
      if (generation === prepareGenerationRef.current) { setPreparing(false); setPrepareStep(''); }
    }
  };
  const restoreSavedSession = async (session: SavedSession) => {
    setRestoring(true); setError('');
    try {
      const restored = await restoreSession(session.id);
      setSessionTitle(session.title); setRole(session.role); setAudience(session.audience); setLevel(session.level); setResponseLength(session.response_length || 'Short'); setImportantFacts(session.important_facts); setForbiddenClaims(session.forbidden_claims); setContext(session.context); setVocabulary(session.vocabulary.join(', '));
      setSessionId(restored.id); setPracticeQuestions(restored.questions);
      const storedTranscript = localStorage.getItem(`voxa:transcript:${restored.id}`);
      if (storedTranscript) {
        try { useStore.getState().setTurns(JSON.parse(storedTranscript)); } catch { localStorage.removeItem(`voxa:transcript:${restored.id}`); }
      }
      const mode = (session.session_mode as SessionMode) || 'class';
      setSessionMode(mode);
      if (mode === 'presentation' && session.slide_pages?.length && session.slide_scripts?.length) {
        setSlideDeck(
          session.slide_pages,
          session.slide_scripts.map(entry => ({ scriptEn: entry.scriptEn, pronunciation: entry.pronunciation, scriptEs: entry.scriptEs })),
          session.intro_script ?? null,
          session.outro_script ?? null,
        );
        try {
          const bytes = await loadPresentationPdf(session.id);
          if (bytes.length) setPresentationPdfBytes(bytes);
        } catch {
          setError('Esta presentación se restauró, pero no se encontró su PDF guardado — vuelve a subirlo en modo Presentación si hace falta.');
        }
      } else {
        setSlideDeck([], [], null, null);
      }
      prepare(session.title);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudo restaurar la sesión guardada.'); }
    finally { setRestoring(false); }
  };
  const [pendingRestore, setPendingRestore] = useState<SavedSession | null>(null);
  const hasUnsavedWork = () => Boolean(file) || Boolean(importantFacts.trim() || forbiddenClaims.trim() || context.trim() || vocabulary.trim());
  const requestRestoreSavedSession = (session: SavedSession) => {
    if (hasUnsavedWork()) { setPendingRestore(session); return; }
    void restoreSavedSession(session);
  };
  const confirmRemoveSession = async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setDeleting(true);
    try {
      await deleteSession(id);
      localStorage.removeItem(`voxa:transcript:${id}`);
      setSavedSessions(current => current.filter(session => session.id !== id));
      setPendingDelete(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo eliminar la sesión guardada.');
    } finally {
      setDeleting(false);
    }
  };

  return <div className="page narrow-page">
    <div className="page-heading"><p className="overline">Nueva sesión</p><h1>Prepara tu siguiente conversación</h1><p>Configura solo lo que Voxa necesita para escuchar, entender y ayudarte en el momento correcto.</p><p className="workflow-hint"><strong>1.</strong> Configura el contexto <span>→</span> <strong>2.</strong> Comprueba el equipo <span>→</span> <strong>3.</strong> Ensaya o empieza</p></div>
    <section className="card prepare-card">
      <label>Nombre de la sesión<input aria-label="Nombre de la sesión" value={title} onChange={event => setSessionTitle(event.target.value)} placeholder="Ej.: Revisión de arquitectura" /></label>
      <div className="mode-toggle" role="group" aria-label="Modo de sesión">
        <button type="button" className={sessionMode === 'class' ? 'active' : ''} onClick={() => setSessionMode('class')}><strong>Clase</strong><small>Sin diapositivas, con preguntas de práctica</small></button>
        <button type="button" className={sessionMode === 'presentation' ? 'active' : ''} onClick={() => setSessionMode('presentation')}><strong>Presentación</strong><small>Doble pantalla con guion en vivo</small></button>
        <button type="button" className={sessionMode === 'reunion' ? 'active' : ''} onClick={() => setSessionMode('reunion')}><strong>Reunión</strong><small>No presentas nada: solo transcripción y traducción</small></button>
      </div>
      {sessionMode === 'presentation' && <label className="file-field">Archivo de la presentación <span className="file-picker">
        <FileText size={20} /><span><strong>{file?.name || 'Añadir un PDF'}</strong><small>{file ? 'Listo para usar' : 'Obligatorio · solo PDF · máximo 25 MB'}</small></span>
        <span className="file-action"><Upload size={15} /> Buscar</span>
        <input aria-label="Archivo de la presentación" type="file" accept=".pdf" onChange={event => setFile(event.target.files?.[0] || null)} />
      </span><small className="document-privacy">El modo presentación necesita texto seleccionable en el PDF: se usa para mostrarlo en pantalla y generar el guion por diapositiva.</small></label>}
      <details className="optional-fields" open>
        <summary>Contexto de esta sesión <span>Recomendado</span><ChevronDown size={17} /></summary>
        <div className="optional-content">
          <div className="two-fields"><label>Tu función<input aria-label="Tu función" value={role} onChange={event => setRole(event.target.value)} /></label><label>Audiencia<select aria-label="Audiencia" value={audience} onChange={event => setAudience(event.target.value)}><option value="Engineering team">Equipo de ingeniería</option><option value="Managers">Directivos</option><option value="Mixed audience">Audiencia mixta</option></select></label></div>
          <div className="two-fields"><label>Nivel de inglés<select aria-label="Nivel de inglés" value={level} onChange={event => setLevel(event.target.value)}><option>B1</option><option>B2</option><option>C1</option></select></label><label>Extensión de la respuesta<select aria-label="Extensión de la respuesta" value={responseLength} onChange={event => setResponseLength(event.target.value)}><option value="Short">Corta</option><option value="Medium">Media</option></select></label></div>
          <label>Datos importantes<textarea aria-label="Datos importantes" value={importantFacts} onChange={event => setImportantFacts(event.target.value)} placeholder="Números, fechas o decisiones que Voxa debe recordar" /></label>
          <label>No afirmar<textarea aria-label="Cosas que no se deben afirmar" value={forbiddenClaims} onChange={event => setForbiddenClaims(event.target.value)} placeholder="Datos desconocidos, temas sensibles o límites" /></label>
          <label>Contexto del proyecto<textarea aria-label="Contexto del proyecto" value={context} onChange={event => setContext(event.target.value)} placeholder="Empresa, objetivo del proyecto y antecedentes relevantes" /><small className="field-hint">Esto se suma a tu perfil general (Configuración → Perfil) — úsalo para lo específico de esta sesión.</small></label>
          <label>Términos técnicos<textarea aria-label="Vocabulario técnico" value={vocabulary} onChange={event => setVocabulary(event.target.value)} placeholder="Nombres de productos y vocabulario especializado" /><small className="field-hint">Se añade al vocabulario que Voxa ya recuerda de tu perfil, no lo reemplaza.</small></label>
        </div>
      </details>
      {error && <p className="form-error"><AlertTriangle size={16} />{error}</p>}
      <div className="prepare-actions">
        <button className="primary-button full-button" onClick={prepareClick} disabled={!title.trim() || preparing || (sessionMode === 'presentation' && !file)}>{preparing ? (prepareStep || 'Preparando…') : sessionMode === 'reunion' ? 'Preparar e ir a En vivo' : 'Preparar sesión'} {!preparing && <ArrowRight size={17} />}</button>
        {preparing && <button className="secondary-button" onClick={cancelPreparing}>Cancelar</button>}
      </div>
    </section>
    {savedSessions.length > 0 && <details className="saved-sessions"><summary>Sesiones recientes <span>{savedSessions.length}</span><ChevronDown size={17} /></summary><div>{savedSessions.slice().reverse().slice(0, 5).map(session => <div className="saved-session-row" key={session.id}><button className="session-open" disabled={restoring} onClick={() => requestRestoreSavedSession(session)}><span>{session.title}</span><small>{audienceLabel(session.audience)} · {session.level}</small><ArrowRight size={15} /></button><button className="session-delete" disabled={restoring} onClick={() => setPendingDelete(session)} aria-label={`Eliminar ${session.title}`}>Eliminar</button></div>)}</div></details>}
    {pendingDelete && <ConfirmDialog title="Eliminar sesión guardada" message={`Esto elimina "${pendingDelete.title}" y su transcripción guardada. No se puede deshacer.`} confirmLabel="Eliminar" danger busy={deleting} onConfirm={() => void confirmRemoveSession()} onCancel={() => setPendingDelete(null)} />}
    {pendingRestore && <ConfirmDialog title="Descartar lo que llevas escrito" message={`Tienes datos sin guardar en este formulario. Abrir "${pendingRestore.title}" los va a reemplazar.`} confirmLabel="Abrir de todas formas" danger onConfirm={() => { const target = pendingRestore; setPendingRestore(null); void restoreSavedSession(target); }} onCancel={() => setPendingRestore(null)} />}
  </div>;
}

function Practice() {
  const { setScreen, startLive, practiceQuestions, sessionMode, slidePages, presentationPdfBytes, setPresentationMonitorIndex } = useStore();
  const [selected, setSelected] = useState(0);
  const [showAnswer, setShowAnswer] = useState(true);
  const selectedItem = practiceQuestions[selected];
  const [monitors, setMonitors] = useState<MonitorInfo[] | null>(null);
  const [selectedMonitor, setSelectedMonitor] = useState(0);
  const [starting, setStarting] = useState(false);
  const [pickerError, setPickerError] = useState('');
  const [systemCheck, setSystemCheck] = useState<SystemCheck | null>(null);

  useEffect(() => {
    checkSystem().then(setSystemCheck).catch(() => setSystemCheck(null));
  }, []);
  useEffect(() => {
    if (sessionMode !== 'presentation') return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listMonitors();
        if (cancelled) return;
        setMonitors(list);
        setSelectedMonitor(list.length > 1 ? 1 : 0);
        void identifyMonitors();
      } catch (cause) {
        if (!cancelled) setPickerError(cause instanceof Error ? cause.message : 'No se pudieron detectar los monitores.');
      }
    })();
    return () => { cancelled = true; };
  }, [sessionMode]);

  const goLive = () => { startLive(false); setScreen('live'); };

  const confirmMonitor = async () => {
    if (!presentationPdfBytes || !slidePages.length) {
      setPickerError('Falta el PDF de la presentación. Vuelve a Preparar.');
      return;
    }
    setStarting(true); setPickerError('');
    try {
      await setPresentationPdf(presentationPdfBytes);
      await openPresenterWindow(selectedMonitor);
      setPresentationMonitorIndex(selectedMonitor);
      startLive(false);
      setScreen('live');
    } catch (cause) {
      setPickerError(cause instanceof Error ? cause.message : 'No se pudo abrir la ventana de presentación.');
    } finally {
      setStarting(false);
    }
  };

  return <div className="page practice-page">
    <div className="page-heading compact-heading"><p className="overline">Ensayo {sessionMode === 'presentation' && '· antes de la pantalla pública'}</p><h1>Ensaya las preguntas difíciles</h1><p>Intenta responder primero. Revela la sugerencia solo cuando quieras comparar.</p></div>
    <div className="practice-grid">
      <section className="question-list card" aria-label="Preguntas probables">{practiceQuestions.length ? practiceQuestions.map((item, index) => <button key={`${item.question}-${index}`} className={selected === index ? 'selected' : ''} onClick={() => { setSelected(index); setShowAnswer(false); }}><span>{item.question}</span><ArrowRight size={16} /></button>) : <div className="practice-empty"><p className="empty-copy">Todavía no hay preguntas para ensayar.</p><button className="secondary-button" onClick={() => setScreen('prepare')}>Volver a preparar</button></div>}</section>
      <section className="practice-answer card"><p className="overline">Pregunta seleccionada</p><h2>{selectedItem?.question || 'Aquí aparecerán tus preguntas.'}</h2>{selectedItem && <>{showAnswer ? <p className="answer-text">{selectedItem.answer}</p> : <div className="answer-placeholder">Responde en voz alta o escribe tu idea en 30 segundos.</div>}<div className="practice-actions"><button className="secondary-button" onClick={() => setShowAnswer(value => !value)}>{showAnswer ? 'Ocultar sugerencia' : 'Revelar sugerencia'}</button><button className="secondary-button" onClick={() => setShowAnswer(true)}>Marcar como revisada</button></div></>}{sessionMode !== 'presentation' && <button className="primary-button full-button" disabled={!practiceQuestions.length} onClick={goLive}>Configurar audio y empezar <Radio size={17} /></button>}</section>
    </div>
    <section className="card readiness-card">
      <div className="readiness-head"><div><p className="overline">Comprobación previa</p><h2>Comprueba tu espacio antes de empezar</h2></div><button className="secondary-button" onClick={() => void checkSystem().then(setSystemCheck)}>Volver a comprobar</button></div>
      <div className="readiness-list"><span className={systemCheck?.apiConfigured ? 'ready' : 'attention'}><i />Gemini {systemCheck?.apiConfigured ? 'conectado' : 'pendiente'}</span><span className={systemCheck?.microphone ? 'ready' : 'attention'}><i />Micrófono {systemCheck?.microphone ? 'disponible' : 'revisar'}</span>{sessionMode !== 'reunion' && <span className={systemCheck?.loopback ? 'ready' : 'attention'}><i />Audio del computador {systemCheck?.loopback ? 'disponible' : 'revisar'}</span>}</div>
      <p className="field-hint">Puedes preparar la sesión aunque algo esté pendiente; Voxa te permitirá reintentarlo antes de escuchar.</p>
    </section>
    {sessionMode === 'presentation' && <section className="card monitor-step">
      <div className="page-heading compact-heading"><p className="overline">Paso 2 de 2</p><h2>Elige tu pantalla pública</h2><p className="supporting">Esa pantalla mostrará el PDF a pantalla completa (la que compartes por Zoom/Teams). El resto se queda como tu ventana de control con el guion. Cada monitor muestra brevemente su número — igual que "Identificar" en Windows.</p></div>
      <div className="deck-status">
        <span className={`status-chip ${presentationPdfBytes ? 'ok' : 'warn'}`}>{presentationPdfBytes ? 'PDF listo ✓' : 'Falta el PDF'}</span>
        <span className={`status-chip ${slidePages.length ? 'ok' : 'warn'}`}>{slidePages.length ? `Guion listo (${slidePages.length} diapositivas) ✓` : 'Falta el guion'}</span>
      </div>
      {monitors === null && !pickerError && <p className="empty-copy">Detectando monitores…</p>}
      {monitors && <div className="monitor-list">{monitors.map(monitor => <button key={monitor.index} type="button" className={`monitor-option ${selectedMonitor === monitor.index ? 'selected' : ''}`} onClick={() => setSelectedMonitor(monitor.index)}><span className="monitor-badge">{monitor.index + 1}</span><MonitorIcon size={18} /><span><strong>{monitor.name}</strong><small>{monitor.width}×{monitor.height}</small></span></button>)}</div>}
      {monitors && <button type="button" className="secondary-button" onClick={() => void identifyMonitors()}>Identificar pantallas de nuevo</button>}
      {pickerError && <p className="form-error"><AlertTriangle size={16} />{pickerError}</p>}
      <button className="primary-button full-button" disabled={!monitors || starting || !presentationPdfBytes || !slidePages.length} onClick={() => void confirmMonitor()}>{starting ? 'Abriendo…' : 'Empezar presentación'} {!starting && <Radio size={17} />}</button>
    </section>}
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
      const status = await startAudioCapture();
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

function Live() {
  const { answer, answerLoading, answerError, activeQuestion, questionQueue, answerCostUsd, liveUsage, turns, interimTranscripts, paused, setPaused, setAnswerText, removeQueuedQuestion, endLive, capturePhase, captureError, audioSources, sessionId, sessionTitle, sessionMode, slidePages, slideScripts, introScript, outroScript, currentSlideIndex, setCurrentSlideIndex, presentationPhase, setPresentationPhase, presentationFinished, setPresentationFinished, presentationPdfBytes, presentationMonitorIndex } = useStore();
  const [sourceEnabled, setSourceEnabled] = useState<Record<'ME' | 'THEM', boolean>>({ ME: true, THEM: true });
  const [activeSeconds, setActiveSeconds] = useState<Record<'ME' | 'THEM', number>>({ ME: 0, THEM: 0 });
  const [sourceBusy, setSourceBusy] = useState<'ME' | 'THEM' | null>(null);
  const [variantBusy, setVariantBusy] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [presenterOpen, setPresenterOpen] = useState(true);
  const [reopening, setReopening] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
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
      await openPresenterWindow(presentationMonitorIndex);
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
      const status = await startAudioCapture();
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
  const statusText = capturePhase === 'starting' ? 'Comprobando audio…' : capturePhase === 'error' ? 'Audio no disponible' : paused ? 'Escucha en pausa' : capturePhase === 'stopped' ? 'Audio detenido' : 'Escuchando';
  useEffect(() => {
    if (paused || capturePhase !== 'listening') return;
    const timer = window.setInterval(() => setActiveSeconds(current => ({
      ME: current.ME + (sourceEnabled.ME ? 1 : 0),
      THEM: current.THEM + (sourceEnabled.THEM ? 1 : 0),
    })), 1000);
    return () => window.clearInterval(timer);
  }, [capturePhase, paused, sourceEnabled.ME, sourceEnabled.THEM]);
  const sourceTranscriptionCost = (speaker: 'ME' | 'THEM') => {
    const usage = liveUsage[speaker];
    const tokenCost = usage.inputTokens * 3.5 / 1_000_000 + usage.outputTokens * 21 / 1_000_000;
    return tokenCost > 0 ? tokenCost : activeSeconds[speaker] * 0.009 / 60;
  };
  const transcriptionCost = sourceTranscriptionCost('ME') + sourceTranscriptionCost('THEM');
  const estimatedCost = transcriptionCost + answerCostUsd;
  const costLabel = estimatedCost < 0.01 ? estimatedCost.toFixed(4) : estimatedCost.toFixed(3);
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
  return <div className="live-page">
    <header className="live-header"><div className={`live-state ${capturePhase === 'error' ? 'error' : ''}`}><i /><strong>{statusText}</strong><span>Audio no guardado · transcripción local</span></div><div className="live-actions">{questionQueue.length > 0 && <span className="queue-badge">{questionQueue.length} en cola</span>}<button className="secondary-button" onClick={() => void toggleListening()}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? 'Reanudar escucha' : 'Pausar escucha'} <span className="shortcut-hint">Espacio</span></button>{sessionMode === 'presentation' && slidePages.length > 0 && <button className="secondary-button" onClick={restartPresentation}><RotateCcw size={14} /> Reiniciar guion</button>}<button className="end-button" onClick={() => setConfirmEnd(true)}>Terminar sesión</button></div></header>
    {sessionMode === 'presentation' && !presenterOpen && <div className="presenter-reopen"><span>Cerraste la pantalla pública (Esc).</span><button onClick={() => void reopenPresenter()} disabled={reopening}>{reopening ? 'Abriendo…' : 'Reabrir pantalla pública'}</button></div>}
    {sessionMode === 'presentation' && !presentationFinished && slidePages.length > 0 && <Teleprompter slidePages={slidePages} slideScripts={slideScripts} introScript={introScript} outroScript={outroScript} currentSlideIndex={currentSlideIndex} setCurrentSlideIndex={setCurrentSlideIndex} phase={presentationPhase} setPhase={setPresentationPhase} onFinishPresentation={() => setPresentationFinished(true)} />}
    {(captureError || transcriptionError || needsApiKey) && <div className="inline-alert" role="alert"><AlertTriangle size={18} /><span><strong>{captureError ? 'No se pudo iniciar la captura.' : transcriptionError ? 'La transcripción no está disponible.' : 'Gemini todavía no está conectado.'}</strong> {captureError || transcriptionError || 'Puedes conectar Gemini desde Configuración y reintentar sin perder esta sesión.'}</span>{needsApiKey ? <button onClick={() => window.dispatchEvent(new Event('voxa-open-settings'))}>Abrir Gemini</button> : <button onClick={() => void toggleListening()}>Reintentar audio</button>}</div>}
    <section className="audio-strip" aria-label="Estado de las fuentes de audio"><AudioSource label="Tú" icon={<Mic size={17} />} source={audioSources.ME} enabled={sourceEnabled.ME} disabled={paused || sourceBusy !== null} onToggle={() => void toggleSource('ME')} /><AudioSource label="Computador" icon={<Volume2 size={17} />} source={audioSources.THEM} enabled={sourceEnabled.THEM} disabled={paused || sourceBusy !== null} onToggle={() => void toggleSource('THEM')} /></section>
    {sessionMode !== 'reunion' && <section className="copilot-area" aria-live="polite">
      {answer ? <>
        <div className="question-block"><p className="overline">Te preguntaron</p><h1>{answer.questionEn}</h1><p className="translation">{answer.questionEs}</p></div>
        <article className="say-card">
          <div className="say-title"><p className="overline">Di esto en inglés</p><span className={`confidence ${answer.confidence.toLowerCase()}`}>{answer.confidence === 'HIGH' ? 'Basado en tu contexto' : answer.confidence === 'MEDIUM' ? 'Revisa los detalles' : 'Falta información'}</span></div>
          <p className="spoken-answer">{answer.answer}</p>
          {answer.warning && <p className="answer-warning"><AlertTriangle size={16} />{answer.warning}</p>}
          <div className="answer-actions"><button disabled={variantBusy} onClick={() => void runVariant('shorter')}>Más corta <span className="shortcut-hint">Ctrl+Shift+S</span></button><button disabled={variantBusy} onClick={() => void runVariant('more')}>Añadir detalle <span className="shortcut-hint">Ctrl+Shift+M</span></button><button disabled={variantBusy} onClick={() => void runVariant('alternative')}>Otra respuesta <span className="shortcut-hint">Ctrl+Shift+A</span></button></div>
        </article>
        <details className="more-answer"><summary>Más información por si preguntan <ChevronDown size={17} /></summary><p>{answer.more}</p><small>{answer.idea}</small></details>
        {questionQueue.length > 0 && <div className="question-queue"><div><strong>{questionQueue.length} {questionQueue.length === 1 ? 'pregunta adicional' : 'preguntas adicionales'}</strong><span>Siguiente: {questionQueue[0]}</span></div><div className="queue-actions"><button className="queue-dismiss" onClick={() => removeQueuedQuestion(questionQueue[0])}>Descartar</button><button onClick={showNextQuestion}>Mostrar siguiente <ArrowRight size={14} /></button></div></div>}
      </> : <div className="waiting-state"><div className="listening-mark"><Radio size={25} /></div><h1>{answerError ? 'Respuesta no disponible' : answerLoading ? 'Preparando tu respuesta' : paused ? 'La escucha está en pausa' : 'Esperando una pregunta'}</h1><p>{answerError || (answerLoading ? activeQuestion : paused ? 'Reanuda cuando estés listo.' : 'Habla o reproduce el audio de la reunión. Los medidores de arriba deben moverse.')}</p>{answerError && activeQuestion && <button className="secondary-button retry-answer" onClick={() => void answerDetectedQuestion(activeQuestion)}>Intentar de nuevo</button>}</div>}
    </section>}
    <details className="transcript-drawer" open={transcriptOpen} onToggle={event => setTranscriptOpen(event.currentTarget.open)}><summary><span>Abrir transcripción</span><small>{turns.length || interimTranscripts.ME || interimTranscripts.THEM ? `${turns.length} intervenciones${interimTranscripts.ME || interimTranscripts.THEM ? ' · escuchando…' : ''}` : 'Disponible cuando haya audio'}</small><ChevronDown size={17} /></summary><div className="turn-list" ref={transcriptRef}>{interimTranscripts.ME && <InterimTurn speaker="ME" text={interimTranscripts.ME} />}{interimTranscripts.THEM && <InterimTurn speaker="THEM" text={interimTranscripts.THEM} />}{turns.slice().reverse().map(turn => <TurnBubble key={turn.id} turn={turn} />)}{!turns.length && !interimTranscripts.ME && !interimTranscripts.THEM && <p className="empty-copy">Aquí aparecerán el audio transcrito y su traducción.</p>}<button className="export-button" onClick={exportTranscript} disabled={!turns.length}><FileText size={14} /> Exportar transcripción</button></div></details>
    {confirmEnd && <ConfirmDialog title="¿Terminar la sesión?" message="Se detendrá la captura y podrás revisar un resumen. La transcripción disponible se conservará en este dispositivo." confirmLabel="Terminar sesión" danger onConfirm={finishLive} onCancel={() => setConfirmEnd(false)} />}
  </div>;
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

function Teleprompter({ slidePages, slideScripts, introScript, outroScript, currentSlideIndex, setCurrentSlideIndex, phase, setPhase, onFinishPresentation }: { slidePages: string[]; slideScripts: SlideScriptEntry[]; introScript: SlideScriptEntry | null; outroScript: SlideScriptEntry | null; currentSlideIndex: number; setCurrentSlideIndex: (index: number) => void; phase: PresentationPhase; setPhase: (phase: PresentationPhase) => void; onFinishPresentation: () => void }) {
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

  const goTo = (index: number) => {
    setCurrentSlideIndex(index);
    void setSlideIndex(index);
  };

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

  return <section className="teleprompter-panel" aria-label="Guion de la presentación">
    <div className="teleprompter-head">
      <span>{headLabel}</span>
      {current && <span className={`teleprompter-timer ${overBudget ? 'over-budget' : ''}`}>{formatSeconds(elapsedSeconds)} / ~{formatSeconds(budgetSeconds)}</span>}
    </div>
    {current ? <>
      <p className="teleprompter-script">{current.scriptEn}</p>
      <p className="teleprompter-pronunciation">{current.pronunciation}</p>
      <p className="teleprompter-spanish">{current.scriptEs}</p>
    </> : <p className="teleprompter-script">Generando guion…</p>}
    <div className="teleprompter-controls">
      <button onClick={goBack} disabled={phase === 'intro'}><ChevronLeft size={15} /> Anterior</button>
      <button onClick={goNext}>{nextLabel} {phase === 'outro' ? <ArrowRight size={15} /> : <ChevronRight size={15} />}</button>
    </div>
    <small className="teleprompter-hint">Esc en la pantalla pública para salir de pantalla completa.</small>
  </section>;
}

function AudioSource({ label, icon, source, enabled, disabled, onToggle }: { label: string; icon: ReactNode; source: ReturnType<typeof useStore.getState>['audioSources']['ME']; enabled: boolean; disabled: boolean; onToggle: () => void }) {
  const connected = source.transcription === 'connected';
  const status = !enabled ? 'Detenido' : source.transcription === 'connecting' ? 'Conectando…' : source.transcription === 'error' ? 'Error de transcripción' : source.transcription === 'offline' ? 'Sin conexión' : source.active ? 'Recibiendo audio' : 'Listo';
  return <div className={`audio-source ${enabled && source.active ? 'active' : ''} ${!enabled ? 'stopped' : ''}`} title={source.device}><span className="source-icon">{icon}</span><div className="source-info"><div><strong>{label}</strong><span className={connected && enabled ? 'connected' : ''}>{status}</span></div><div className="level-track" role="meter" aria-label={`Nivel de audio: ${label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={enabled ? Math.round(source.level * 100) : 0}><i style={{ width: `${enabled ? Math.max(1, source.level * 100) : 0}%` }} /></div></div><button className="source-toggle" onClick={onToggle} disabled={disabled} aria-label={`${enabled ? 'Silenciar' : 'Activar'} audio de ${label}`}>{enabled ? <><Pause size={13} /> Silenciar</> : <><Play size={13} /> Activar</>}</button></div>;
}

function TurnBubble({ turn }: { turn: Turn }) {
  return <div className={`turn ${turn.speaker === 'ME' ? 'turn-me' : 'turn-them'}`}><div><strong>{turn.speaker === 'ME' ? 'Tú' : 'Computador'}</strong><time>{turn.time}</time></div><p className="turn-original">{turn.text}</p>{turn.translation ? <p className="turn-translation" lang={turn.sourceLanguage?.toLowerCase().startsWith('span') ? 'en' : 'es'}>{turn.translation}</p> : turn.translating ? <small className="translation-pending">Traduciendo…</small> : <small className="translation-pending failed">Traducción no disponible</small>}</div>;
}

function InterimTurn({ speaker, text }: { speaker: 'ME' | 'THEM'; text: string }) {
  return <div className="turn interim-turn"><div><strong>{speaker === 'ME' ? 'Tú' : 'Computador'}</strong><time>Transcribiendo…</time></div><p>{text}</p></div>;
}

export default App;
