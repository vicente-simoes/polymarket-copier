import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { AppShell } from '@/components/dashboard/app-shell'
import './globals.css'

export const metadata: Metadata = {
  title: 'PolymarketSpy Dashboard',
  description: 'Control and observability dashboard for the PolymarketSpy copy portfolio system.'
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
