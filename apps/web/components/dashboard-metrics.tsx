"use client"

import { Wallet } from 'lucide-react'

export function DashboardMetrics() {
  return (
    <div className="flex flex-col xl:flex-row gap-8 xl:items-center justify-between p-6 bg-[#0D0D0D] rounded-2xl">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-gray-400">
          <Wallet className="h-5 w-5" />
          <span className="text-lg">Current</span>
        </div>
        <div className="text-5xl md:text-4xl lg:text-5xl font-bold text-white">$6,810</div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-8 xl:gap-16">
        <div className="flex flex-col gap-1">
          <span className="text-gray-400 text-sm">Invested</span>
          <span className="text-2xl md:text-xl lg:text-2xl font-semibold text-white">$5,220</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400 text-sm">Total Returns</span>
          <span className="text-2xl md:text-xl lg:text-2xl font-semibold text-[#86efac]">+$1,590</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400 text-sm">Net Returns</span>
          <span className="text-2xl md:text-xl lg:text-2xl font-semibold text-[#86efac]">+30.46%</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-gray-400 text-sm">1 Day Returns</span>
          <span className="text-2xl md:text-xl lg:text-2xl font-semibold text-[#86efac]">+$142.50</span>
        </div>
      </div>
    </div>
  )
}
