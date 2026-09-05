import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import App from './App';
import PresenterView from './screens/PresenterView';
import IdentifyOverlay from './screens/IdentifyOverlay';
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

function rootView() {
  const label = currentWindowLabel();
  if (label === 'presenter') return <PresenterView />;
  if (label?.startsWith('identify-')) return <IdentifyOverlay index={Number(label.slice('identify-'.length)) || 0} />;
  return <App />;
}

createRoot(document.getElementById('root')!).render(<StrictMode>{rootView()}</StrictMode>);
