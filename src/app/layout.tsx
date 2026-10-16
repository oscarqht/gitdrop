import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Gitdrop — A home for your links',
  description: 'Your bookmarks. Your files. Your history.',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
