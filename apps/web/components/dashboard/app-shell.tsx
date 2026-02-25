'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  BarChart3,
  ClipboardList,
  Gauge,
  Home,
  Menu,
  Settings,
  Shield,
  Users
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview', icon: Home },
  { href: '/leaders', label: 'Leaders', icon: Users },
  { href: '/portfolio', label: 'Portfolio', icon: BarChart3 },
  { href: '/trades', label: 'Trades', icon: Activity },
  { href: '/copies', label: 'Copies', icon: ClipboardList },
  { href: '/config', label: 'Config', icon: Settings },
  { href: '/status', label: 'Status', icon: Shield }
]

function isItemActive(pathname: string, itemPath: string): boolean {
  if (itemPath === '/') {
    return pathname === '/'
  }

  return pathname === itemPath || pathname.startsWith(`${itemPath}/`)
}

function SidebarNav({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="space-y-1">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon
        const active = isItemActive(pathname, item.href)

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition-colors',
              active
                ? 'border-[#86efac]/30 bg-[#86efac]/10 text-[#E7E7E7]'
                : 'border-transparent text-[#919191] hover:border-white/10 hover:bg-white/[0.03] hover:text-[#E7E7E7]'
            )}
          >
            <Icon className={cn('size-4', active ? 'text-[#86efac]' : 'text-[#919191]')} />
            <span className="tracking-[0.08em]">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )
}

function pageTitleFromPath(pathname: string): string {
  if (pathname === '/') {
    return 'Overview'
  }

  const matching = [...NAV_ITEMS].reverse().find((item) => isItemActive(pathname, item.href))
  return matching?.label ?? 'Dashboard'
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  if (pathname === '/login') {
    return <>{children}</>
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-black text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -top-24 left-1/4 h-72 w-72 rounded-full bg-emerald-400/10 blur-3xl" />
        <div className="absolute right-0 top-1/3 h-80 w-80 rounded-full bg-cyan-400/5 blur-3xl" />
      </div>

      <div className="relative flex min-h-screen w-full gap-3 p-2 md:gap-4 md:p-4">
        <aside className="sticky top-4 hidden h-[calc(100vh-2rem)] w-64 shrink-0 rounded-2xl border border-white/10 bg-[#0D0D0D]/95 p-4 shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur md:flex md:flex-col">
          <div className="mb-6 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-3">
            <div className="flex items-center gap-2 text-white">
              <Gauge className="size-5 text-[#86efac]" />
              <p className="text-xs tracking-[0.22em] text-[#919191]">CONTROL</p>
            </div>
            <div>
              <p className="mt-1 text-sm font-semibold">PolymarketSpy</p>
              <p className="text-xs text-[#919191]">Ops dashboard</p>
            </div>
          </div>
          <SidebarNav pathname={pathname} />
          <div className="mt-auto rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <p className="text-[11px] uppercase tracking-[0.22em] text-[#919191]">System</p>
            <div className="mt-2 flex items-center gap-2">
              <span className="inline-block size-2 rounded-full bg-[#86efac]" />
              <p className="text-sm text-[#E7E7E7]">Dashboard online</p>
            </div>
          </div>
        </aside>

        <div className="min-h-screen min-w-0 flex-1">
          <header className="sticky top-2 z-20 mb-3 flex items-center justify-between rounded-2xl border border-white/10 bg-black/30 px-3 py-2.5 backdrop-blur-[60px] md:top-4 md:mb-4 md:px-4 md:py-3">
            <div className="flex items-center gap-3">
              <div className="md:hidden">
                <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
                  <SheetTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      aria-label="Open navigation menu"
                      className="h-9 w-9 border-white/10 bg-white/[0.02] text-white hover:bg-white/[0.06] hover:text-white"
                    >
                      <Menu className="size-4" />
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" className="border-white/10 bg-[#0D0D0D] p-0 text-white">
                    <SheetHeader className="border-b border-white/10 px-4 py-3">
                      <SheetTitle className="text-white">PolymarketSpy</SheetTitle>
                    </SheetHeader>
                    <div className="p-4">
                      <SidebarNav pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
              <div>
                <h1 className="text-sm font-semibold text-[#E7E7E7] sm:text-base md:text-lg">{pageTitleFromPath(pathname)}</h1>
                <p className="hidden text-xs text-[#919191] sm:block">PolymarketSpy control plane</p>
              </div>
            </div>
            <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.02] px-3 py-1.5 md:flex">
              <span className="inline-block size-2 rounded-full bg-[#86efac]" />
              <p className="text-xs tracking-[0.16em] text-[#919191]">LIVE UI</p>
            </div>
          </header>

          <main className="min-w-0 overflow-x-hidden pb-4 md:pb-6">{children}</main>
        </div>
      </div>
    </div>
  )
}
