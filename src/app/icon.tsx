import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #1e293b, #334155)',
          borderRadius: '6px',
          fontSize: 18,
          fontWeight: 800,
          color: '#ffffff',
          letterSpacing: '-0.5px',
        }}
      >
        FT
      </div>
    ),
    { ...size }
  );
}
