import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'EventDD ShotX',
  description: 'AI-powered event photography platform',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
