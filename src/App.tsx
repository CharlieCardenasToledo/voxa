import { useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowRight, ChevronDown, FileText, Mic, Pause, Play, Radio, Settings2, Upload, Volume2 } from 'lucide-react';
import { useStore, type Screen, type Turn } from './store';
import { checkGeminiHealth, checkSystem, extractDocument, generateCopilotAnswer, isNativeRuntime, onAudioLevel, onNativeTranscript, onTranscriptionStatus, prepareNativeSession, setGeminiApiKey, startAudioCapture, startNativeSession, stopAudioCapture, stopNativeSession, type CaptureStatus, type GeminiHealthReport, type SystemCheck } from './services/native';

const screens: { id: Screen; label: string }[] = [
  { id: 'prepare', label: 'Prepare' },
  { id: 'practice', label: 'Practice' },
  { id: 'live', label: 'Live' },
];

function App() {
  const store = useStore();
  const [system, setSystem] = useState<SystemCheck | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');
  const [health, setHealth] = useState<GeminiHealthReport | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const runHealthCheck = async () => {
    setHealthLoading(true);
    try {
      setHealth(await checkGeminiHealth());
    } catch (cause) {
      setHealth({ overallOk: false, checks: [{ id: 'error', label: 'Health check', ok: false, message: cause instanceof Error ? cause.message : 'The health check could not run.', latencyMs: 0 }] });
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    checkSystem().then(setSystem).catch(() => setSystem({ microphone: false, loopback: false, internet: false, apiConfigured: false }));
  }, []);
  useEffect(() => {
    const open = () => { setKeyMessage(''); setSettingsOpen(true); };
    window.addEventListener('voxa-open-settings', open);
    return () => window.removeEventListener('voxa-open-settings', open);
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.shiftKey)) return;
      if (event.key.toLowerCase() === 's') store.cycleAnswer('shorter');
      if (event.key.toLowerCase() === 'm') store.cycleAnswer('more');
      if (event.key.toLowerCase() === 'a') store.cycleAnswer('alternative');
      if (event.code === 'Space') store.setPaused(!store.paused);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  const openSettings = () => { setKeyMessage(''); setSettingsOpen(true); };
  return <div className="app">
    <header className="app-header">
      <button className="wordmark" onClick={() => store.setScreen('prepare')} aria-label="Go to Prepare">Voxa</button>
      <nav className="main-nav" aria-label="Main navigation">
        {screens.map(({ id, label }) => <button key={id} className={store.screen === id ? 'active' : ''} onClick={() => store.setScreen(id)}>{label}</button>)}
      </nav>
      <div className="header-actions">
        <button className={`system-status ${system?.apiConfigured ? 'ready' : 'attention'}`} onClick={!system?.apiConfigured && isNativeRuntime() ? openSettings : undefined}>
          <i />{system?.apiConfigured ? 'Ready' : isNativeRuntime() ? 'Connect Gemini' : 'Browser preview'}
        </button>
        <button className="icon-button" onClick={openSettings} aria-label="Settings"><Settings2 size={18} /></button>
      </div>
    </header>
    <main className={`screen screen-${store.screen}`}>
      {store.screen === 'prepare' && <Prepare />}
      {store.screen === 'practice' && <Practice />}
      {store.screen === 'live' && <><LiveAudioBridge /><Live /></>}
    </main>
    {settingsOpen && <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={event => event.stopPropagation()}>
        <div className="modal-head"><div><p className="overline">Settings</p><h2 id="settings-title">Connect Gemini</h2></div><button className="icon-button" aria-label="Close settings" onClick={() => setSettingsOpen(false)}>×</button></div>
        <p className="supporting">Your key is stored securely in Windows Credential Manager.</p>
        <label>Gemini API key<input aria-label="Gemini API key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="Paste your key" autoFocus /></label>
        {keyMessage && <p className="form-message" role="status">{keyMessage}</p>}
        <div className="health-panel">
          <div className="health-head">
            <p className="overline">Gemini status</p>
            <button className="secondary-button" onClick={runHealthCheck} disabled={healthLoading}>{healthLoading ? 'Checking…' : 'Run health check'}</button>
          </div>
          {health && <ul className="health-list">
            {health.checks.map(check => <li key={check.id} className={check.ok ? 'ok' : 'fail'}>
              <i />
              <div><strong>{check.label}</strong><span>{check.message}</span></div>
              {check.latencyMs > 0 && <small>{check.latencyMs} ms</small>}
            </li>)}
          </ul>}
        </div>
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => setSettingsOpen(false)}>Cancel</button>
          <button className="primary-button" disabled={!apiKey.trim() || savingKey} onClick={async () => {
            setSavingKey(true);
            try {
              await setGeminiApiKey(apiKey.trim());
              setSystem(await checkSystem());
              setKeyMessage('Saved. Voxa is ready.');
              setApiKey('');
            } catch { setKeyMessage('The key could not be saved. Check Windows Credential Manager.'); }
            finally { setSavingKey(false); }
          }}>{savingKey ? 'Saving…' : 'Save'}</button>
        </div>
      </section>
    </div>}
  </div>;
}

function Prepare() {
  const { prepare, setSessionTitle, setSessionId } = useStore();
  const title = useStore(state => state.sessionTitle);
  const [file, setFile] = useState<File | null>(null);
  const [vocabulary, setVocabulary] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');

  const prepareClick = async () => {
    setPreparing(true); setError('');
    try {
      if (file) {
        const extracted = await extractDocument(file.name, new Uint8Array(await file.arrayBuffer()));
        if (extracted.vocabulary.length && !vocabulary.trim()) setVocabulary(extracted.vocabulary.join(', '));
      }
      const id = await prepareNativeSession(title);
      setSessionId(id);
      prepare(title);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'This session could not be prepared.');
    } finally { setPreparing(false); }
  };

  return <div className="page narrow-page">
    <div className="page-heading"><p className="overline">Before the presentation</p><h1>What are you presenting?</h1><p>Give Voxa enough context to answer accurately. You can add details later.</p></div>
    <section className="card prepare-card">
      <label>Session name<input aria-label="Session name" value={title} onChange={event => setSessionTitle(event.target.value)} placeholder="e.g. Architecture review" /></label>
      <label className="file-field">Presentation file <span className="file-picker">
        <FileText size={20} /><span><strong>{file?.name || 'Add a PDF or PowerPoint'}</strong><small>{file ? 'Ready to use' : 'Optional · up to 25 MB'}</small></span>
        <span className="file-action"><Upload size={15} /> Browse</span>
        <input aria-label="Presentation file" type="file" accept=".pdf,.pptx" onChange={event => setFile(event.target.files?.[0] || null)} />
      </span></label>
      <details className="optional-fields">
        <summary>Additional context <span>Optional</span><ChevronDown size={17} /></summary>
        <div className="optional-content">
          <div className="two-fields"><label>Your role<input aria-label="Your role" defaultValue="Software Developer" /></label><label>Audience<select aria-label="Audience" defaultValue="Engineering team"><option>Engineering team</option><option>Managers</option><option>Mixed audience</option></select></label></div>
          <label>Important facts<textarea aria-label="Important facts" placeholder="Numbers, dates or decisions Voxa must remember" /></label>
          <label>Do not claim<textarea aria-label="Things not to claim" placeholder="Unknowns, sensitive topics or boundaries" /></label>
          <label>Technical terms<textarea aria-label="Technical vocabulary" value={vocabulary} onChange={event => setVocabulary(event.target.value)} placeholder="Product names and specialist vocabulary" /></label>
        </div>
      </details>
      {error && <p className="form-error"><AlertTriangle size={16} />{error}</p>}
      <button className="primary-button full-button" onClick={prepareClick} disabled={!title.trim() || preparing}>{preparing ? 'Preparing…' : 'Prepare session'} {!preparing && <ArrowRight size={17} />}</button>
    </section>
  </div>;
}

function Practice() {
  const { setScreen, startLive } = useStore();
  const [selected, setSelected] = useState(0);
  const questions = ['Why did you choose this architecture?', 'How would this scale in production?', 'What are the main trade-offs?', 'What would you change next?'];
  const answers = ['We chose this architecture because it keeps the system simpler to develop and maintain. At our current scale, microservices would add unnecessary complexity.', 'We can scale the system step by step because the main modules are clearly separated. We would monitor usage before adding more infrastructure.', 'The main trade-off is between operational simplicity and independent scaling. For this project, simplicity is more valuable right now.', 'I would improve observability first. That would give us better data before making a larger architecture change.'];
  return <div className="page practice-page">
    <div className="page-heading compact-heading"><p className="overline">Practice</p><h1>Likely questions</h1><p>Select a question and rehearse the short answer.</p></div>
    <div className="practice-grid">
      <section className="question-list card" aria-label="Likely questions">{questions.map((question, index) => <button key={question} className={selected === index ? 'selected' : ''} onClick={() => setSelected(index)}><span>{question}</span><ArrowRight size={16} /></button>)}</section>
      <section className="practice-answer card"><p className="overline">Say this</p><h2>{questions[selected]}</h2><p className="answer-text">{answers[selected]}</p><button className="primary-button full-button" onClick={() => { startLive(false); setScreen('live'); }}>Start listening <Radio size={17} /></button></section>
    </div>
  </div>;
}

function LiveAudioBridge() {
  const sessionId = useStore(state => state.sessionId);
  useEffect(() => {
    if (isNativeRuntime()) useStore.getState().clearLiveDemo();
    let mounted = true;
    const cleanups: (() => void)[] = [];
    const handleTranscript = (transcript: Parameters<Parameters<typeof onNativeTranscript>[0]>[0]) => {
      if (!mounted || transcript.interim) return;
      const now = new Date();
      useStore.getState().addTurn({ speaker: transcript.speaker, text: transcript.text, time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      if (transcript.speaker === 'THEM') {
        const conversation = useStore.getState().turns.map(turn => `[${turn.speaker}] ${turn.text}`).join('\n');
        generateCopilotAnswer(transcript.text, 'Use the prepared presentation context. Do not invent missing facts.', conversation).then(nativeAnswer => {
          if (nativeAnswer && mounted) useStore.getState().setAnswer({ questionEn: nativeAnswer.question_en, questionEs: nativeAnswer.question_es, answer: nativeAnswer.answer_b2, more: nativeAnswer.extension_b2, idea: nativeAnswer.key_idea_es, confidence: nativeAnswer.confidence, warning: nativeAnswer.warning || undefined });
        }).catch(error => console.error('Copilot answer unavailable', error));
      }
    };
    const start = async () => {
      useStore.getState().setCapture('starting');
      useStore.getState().setAudioSource('ME', { transcription: 'connecting' });
      useStore.getState().setAudioSource('THEM', { transcription: 'connecting' });
      const listeners = await Promise.all([
        onNativeTranscript(handleTranscript),
        onAudioLevel(level => { if (mounted) useStore.getState().setAudioSource(level.speaker, { level: Math.min(1, level.rms * 8), active: level.active }); }),
        onTranscriptionStatus(status => { if (mounted) useStore.getState().setAudioSource(status.speaker, status.error ? { transcription: 'error', error: status.error } : { transcription: 'connected', error: undefined }); }),
      ]);
      cleanups.push(...listeners);
      if (sessionId) await startNativeSession(sessionId);
      const status = await startAudioCapture();
      applyCaptureStatus(status);
      if (!(await checkSystem()).apiConfigured) {
        const patch = { transcription: 'offline' as const, error: 'Connect Gemini to enable transcription.' };
        useStore.getState().setAudioSource('ME', patch);
        useStore.getState().setAudioSource('THEM', patch);
      }
    };
    start().catch(error => { if (mounted) useStore.getState().setCapture('error', error instanceof Error ? error.message : String(error)); });
    return () => { mounted = false; cleanups.forEach(cleanup => cleanup()); useStore.getState().setCapture('stopped'); void stopAudioCapture(); };
  }, [sessionId]);
  return null;
}

function applyCaptureStatus(status: CaptureStatus) {
  const store = useStore.getState();
  store.setAudioSource('ME', { device: status.microphone_name || 'Default microphone' });
  store.setAudioSource('THEM', { device: status.loopback_name || 'Default system output' });
  store.setCapture(status.running ? 'listening' : 'error', status.error);
}

function Live() {
  const { answer, turns, paused, setPaused, cycleAnswer, endLive, capturePhase, captureError, audioSources } = useStore();
  const needsApiKey = audioSources.ME.transcription === 'offline' || audioSources.THEM.transcription === 'offline';
  const transcriptionError = audioSources.ME.error || audioSources.THEM.error;
  const toggleListening = async () => {
    if (paused) {
      useStore.getState().setCapture('starting');
      const status = await startAudioCapture();
      applyCaptureStatus(status);
      if (status.running) setPaused(false);
    } else {
      await stopAudioCapture();
      setPaused(true);
      useStore.getState().setCapture('paused');
      useStore.getState().setAudioSource('ME', { level: 0, active: false });
      useStore.getState().setAudioSource('THEM', { level: 0, active: false });
    }
  };
  const statusText = capturePhase === 'starting' ? 'Starting…' : capturePhase === 'error' ? 'Audio problem' : paused ? 'Paused' : 'Listening';
  return <div className="live-page">
    <header className="live-header"><div className={`live-state ${capturePhase === 'error' ? 'error' : ''}`}><i /><strong>{statusText}</strong><span>Audio is not saved</span></div><div className="live-actions"><button className="secondary-button" onClick={toggleListening}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? 'Resume' : 'Pause'}</button><button className="end-button" onClick={() => { void stopNativeSession(); endLive(); }}>End</button></div></header>
    {(captureError || transcriptionError || needsApiKey) && <div className="inline-alert" role="alert"><AlertTriangle size={18} /><span><strong>{captureError ? 'Voxa cannot access audio.' : transcriptionError ? 'Gemini could not start transcription.' : 'Audio works, but transcription is off.'}</strong>{captureError || transcriptionError || ' Connect Gemini to turn speech into text.'}</span>{needsApiKey && <button onClick={() => window.dispatchEvent(new Event('voxa-open-settings'))}>Connect Gemini</button>}</div>}
    <section className="audio-strip" aria-label="Audio input status"><AudioSource label="You" icon={<Mic size={17} />} source={audioSources.ME} /><AudioSource label="Computer" icon={<Volume2 size={17} />} source={audioSources.THEM} /></section>
    <section className="copilot-area" aria-live="polite">
      {answer ? <>
        <div className="question-block"><p className="overline">They asked</p><h1>{answer.questionEn}</h1><p className="translation">{answer.questionEs}</p></div>
        <article className="say-card">
          <div className="say-title"><p className="overline">Say this</p><span className={`confidence ${answer.confidence.toLowerCase()}`}>{answer.confidence === 'HIGH' ? 'Based on your context' : answer.confidence === 'MEDIUM' ? 'Check the details' : 'Information missing'}</span></div>
          <p className="spoken-answer">{answer.answer}</p>
          {answer.warning && <p className="answer-warning"><AlertTriangle size={16} />{answer.warning}</p>}
          <div className="answer-actions"><button onClick={() => cycleAnswer('shorter')}>Shorter</button><button onClick={() => cycleAnswer('more')}>Add detail</button><button onClick={() => cycleAnswer('alternative')}>Another answer</button></div>
        </article>
        <details className="more-answer"><summary>More if they ask <ChevronDown size={17} /></summary><p>{answer.more}</p><small>{answer.idea}</small></details>
      </> : <div className="waiting-state"><div className="listening-mark"><Radio size={25} /></div><h1>{paused ? 'Listening is paused' : 'Waiting for a question'}</h1><p>{paused ? 'Resume when you are ready.' : 'Speak or play meeting audio. The meters above should move.'}</p></div>}
    </section>
    <details className="transcript-drawer"><summary><span>Transcript</span><small>{turns.length ? `${turns.length} messages` : 'No speech yet'}</small><ChevronDown size={17} /></summary><div className="turn-list">{turns.length ? turns.map((turn, index) => <TurnBubble key={`${turn.time}-${index}`} turn={turn} />) : <p className="empty-copy">Transcribed speech will appear here.</p>}</div></details>
  </div>;
}

function AudioSource({ label, icon, source }: { label: string; icon: ReactNode; source: ReturnType<typeof useStore.getState>['audioSources']['ME'] }) {
  const connected = source.transcription === 'connected';
  const status = source.transcription === 'connecting' ? 'Connecting…' : source.transcription === 'error' ? 'Transcription error' : source.transcription === 'offline' ? 'Not connected' : source.active ? 'Hearing audio' : 'Ready';
  return <div className={`audio-source ${source.active ? 'active' : ''}`} title={source.device}><span className="source-icon">{icon}</span><div className="source-info"><div><strong>{label}</strong><span className={connected ? 'connected' : ''}>{status}</span></div><div className="level-track" role="meter" aria-label={`${label} audio level`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(source.level * 100)}><i style={{ width: `${Math.max(1, source.level * 100)}%` }} /></div></div></div>;
}

function TurnBubble({ turn }: { turn: Turn }) {
  return <div className="turn"><div><strong>{turn.speaker === 'ME' ? 'You' : 'Computer'}</strong><time>{turn.time}</time></div><p>{turn.text}</p></div>;
}

export default App;
