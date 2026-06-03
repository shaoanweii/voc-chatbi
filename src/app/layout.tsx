import type { Metadata } from 'next';
import { AuthProvider } from '@/components/auth-provider';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'VOC｜智能问数',
  description: '连接数据库或上传表格，用自然语言直接得到业务答案',
  keywords: ['智能问数', 'AI', '数据分析', 'VOC', 'SQL'],
  icons: {
    icon: [
      { url: '/assets/favicon.ico', sizes: 'any' },
      { url: '/assets/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/assets/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
    ],
    apple: '/assets/apple-icon.png',
    other: [
      { url: '/assets/android-chrome-192x192.png', sizes: '192x192' },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={`antialiased`}>
        <AuthProvider>{children}</AuthProvider>
        <Toaster
          position="top-center"
          toastOptions={{
            style: {
              background: 'rgba(255,255,255,0.92)',
              backdropFilter: 'blur(20px)',
              border: '1px solid rgba(226,232,240,0.8)',
              borderRadius: '16px',
              boxShadow: '0 16px 48px rgba(15,23,42,0.10)',
              color: '#0f172a',
              fontFamily: 'inherit',
              fontSize: '14px',
            },
          }}
        />
      </body>
    </html>
  );
}
