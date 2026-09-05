import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import './styles.css';
import './ux.css';

function currentWindowLabel(): string | null {
  if (!('__TAURI_INTERNALS__' in window || '__TAURI__' in window)) return null;
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    return null;
  }
}

async function rootView() {
  const label = currentWindowLabel();
  if (label === 'presenter') {
    const { default: PresenterView } = await import('./screens/PresenterView');
    return <PresenterView />;
  }
  if (label?.startsWith('identify-')) {
    const { default: IdentifyOverlay } = await import('./screens/IdentifyOverlay');
    return <IdentifyOverlay index={Number(label.slice('identify-'.length)) || 0} />;
  }
  const { default: App } = await import('./App');
  return <App />;
}

async function bootstrap() {
  const view = await rootView();
  createRoot(document.getElementById('root')!).render(<StrictMode>{view}</StrictMode>);
}

void bootstrap();
