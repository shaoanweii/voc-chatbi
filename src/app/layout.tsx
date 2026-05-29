import type { Metadata } from 'next';
import { AuthProvider } from '@/components/auth-provider';
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
      </body>
    </html>
  );
}
