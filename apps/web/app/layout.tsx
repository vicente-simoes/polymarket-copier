import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { AppShell } from '@/components/dashboard/app-shell'
import './globals.css'

export const metadata: Metadata = {
  title: 'PolymarketSpy',
  description: 'Control and observability dashboard for the PolymarketSpy copy portfolio system.',
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-dark-32x32.png', sizes: '32x32', type: 'image/png' }
    ],
    shortcut: [{ url: '/icon-dark-32x32.png', sizes: '32x32', type: 'image/png' }],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }]
  }
}

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <AppShell>{children}</AppShell>
        <Analytics />
      </body>
    </html>
  )
}
