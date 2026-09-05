export default function IdentifyOverlay({ index }: { index: number }) {
  return <div style={{
    width: '100vw', height: '100vh', background: '#2f6fed', color: '#fff',
    display: 'grid', placeItems: 'center', fontFamily: '"Segoe UI Variable","Segoe UI",system-ui,sans-serif',
    borderRadius: 10, boxShadow: '0 0 0 1px rgba(255,255,255,.25) inset',
  }}>
    <span style={{ fontSize: 88, fontWeight: 700, lineHeight: 1 }}>{index + 1}</span>
  </div>;
}
