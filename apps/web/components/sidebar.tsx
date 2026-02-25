"use client"

import { Blocks, BarChart3, Rabbit, Container, Banknote, SquareArrowOutUpRight, Settings2, LogOut } from 'lucide-react'

export function Sidebar() {
  return (
    <aside className="sticky top-24 h-[calc(100vh-8rem)] md:w-48 lg:w-64 bg-[#0D0D0D] rounded-2xl hidden md:flex flex-col p-8 overflow-y-auto">
      <nav className="flex flex-col gap-8">
        <div className="flex items-center gap-4 text-[#E7E7E7] cursor-pointer">
          <Blocks className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">DASHBOARD</span>
        </div>
        <div className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer">
          <BarChart3 className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">ANALYTICS</span>
        </div>
        <div className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer">
          <Rabbit className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">ARBITRADER</span>
        </div>
        <div className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer">
          <Container className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">RESEARCHER</span>
        </div>
        <div className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer">
          <Banknote className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">FUNDS</span>
        </div>
      </nav>

      <div className="mt-auto pt-8 border-t border-[#1F1F1F] flex flex-col gap-8">
        <div className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer">
          <SquareArrowOutUpRight className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">FINBRO SUPPORT</span>
        </div>
        <div className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer">
          <Settings2 className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">SETTINGS</span>
        </div>
        <div className="flex items-center gap-4 text-[#919191] hover:text-[#E7E7E7] transition-colors cursor-pointer">
          <LogOut className="h-6 w-6" />
          <span className="text-sm font-medium tracking-wide">LOGOUT</span>
        </div>
      </div>
    </aside>
  )
}
