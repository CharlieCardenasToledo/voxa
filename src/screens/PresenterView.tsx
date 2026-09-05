import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getPresentationPdf, onSlideChanged } from '../services/native';
import { loadPdf, renderPdfPage } from '../services/pdf';

export default function PresenterView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const bytes = await getPresentationPdf();
        const doc = await loadPdf(bytes);
        if (cancelled) return;
        docRef.current = doc;
        await renderCurrentPage();
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
      void unlisten.then(cleanup => cleanup());
      window.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderCurrentPage = async () => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    const page = Math.min(Math.max(pageNumber, 1), doc.numPages);
    await renderPdfPage(doc, page, canvas, window.innerWidth, window.innerHeight);
  };

  useEffect(() => { void renderCurrentPage(); }, [pageNumber]);

  return <div style={{ width: '100vw', height: '100vh', background: '#000', display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
    {error ? <p style={{ color: '#fff', fontFamily: 'sans-serif' }}>{error}</p> : <canvas ref={canvasRef} />}
  </div>;
}
