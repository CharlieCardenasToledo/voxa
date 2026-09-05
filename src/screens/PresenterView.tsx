import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getPresentationPdf, onSlideChanged } from '../services/native';
import { loadPdf, renderPdfPage } from '../services/pdf';

export default function PresenterView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const renderQueueRef = useRef<Promise<void>>(Promise.resolve());
  const renderRequestRef = useRef(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bytes = await getPresentationPdf();
        const doc = await loadPdf(bytes);
        if (cancelled) {
          await doc.loadingTask.destroy();
          return;
        }
        docRef.current = doc;
        setReady(true);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'No se pudo cargar la presentación.');
      }
    })();
    const unlisten = onSlideChanged(index => setPageNumber(index + 1));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void getCurrentWebviewWindow().close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      cancelled = true;
      renderRequestRef.current += 1;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      void docRef.current?.loadingTask.destroy();
      void unlisten.then(cleanup => cleanup());
      window.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ready) return;
    const request = ++renderRequestRef.current;
    renderTaskRef.current?.cancel();
    renderQueueRef.current = renderQueueRef.current.catch(() => undefined).then(async () => {
      if (request !== renderRequestRef.current) return;
      const doc = docRef.current;
      const canvas = canvasRef.current;
      if (!doc || !canvas) return;
      const page = Math.min(Math.max(pageNumber, 1), doc.numPages);
      try {
        setError('');
        const task = await renderPdfPage(doc, page, canvas, window.innerWidth, window.innerHeight);
        if (!task || request !== renderRequestRef.current) {
          task?.cancel();
          return;
        }
        renderTaskRef.current = task;
        await task.promise;
      } catch (cause) {
        if (request === renderRequestRef.current && (cause as { name?: string })?.name !== 'RenderingCancelledException') {
          setError(cause instanceof Error ? cause.message : 'No se pudo mostrar esta diapositiva.');
        }
      } finally {
        if (request === renderRequestRef.current) renderTaskRef.current = null;
      }
    });
  }, [pageNumber, ready]);

  useEffect(() => {
    let timer = 0;
    const resize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        renderRequestRef.current += 1;
        renderTaskRef.current?.cancel();
        // Force a render even when the page number did not change.
        setReady(false);
        window.requestAnimationFrame(() => setReady(true));
      }, 120);
    };
    window.addEventListener('resize', resize);
    return () => { window.clearTimeout(timer); window.removeEventListener('resize', resize); };
  }, []);

  return <div style={{ width: '100vw', height: '100vh', background: '#000', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
    <canvas ref={canvasRef} style={{ display: error ? 'none' : 'block' }} />
    {error && <p style={{ color: '#fff', fontFamily: 'sans-serif', padding: 24 }}>{error}</p>}
  </div>;
}
