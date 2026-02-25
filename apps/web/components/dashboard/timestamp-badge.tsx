import { Clock3 } from 'lucide-react'
import { formatDateTime } from '@/lib/format'

interface TimestampBadgeProps {
  value: string | null | undefined
  prefix?: string
}

export function TimestampBadge({ value, prefix = 'Updated' }: TimestampBadgeProps) {
  return (
    <div className="inline-flex max-w-full items-center gap-1.5 rounded-xl border border-white/15 bg-white/[0.06] px-2 py-1 text-[11px] leading-tight text-[#CFCFCF] shadow-[0_0_0_1px_rgba(255,255,255,0.02)] sm:px-2.5 sm:text-xs">
      <Clock3 className="size-3.5 shrink-0 text-[#919191]" />
      <span className="min-w-0 truncate sm:max-w-none">
        {prefix}: {formatDateTime(value)}
      </span>
    </div>
  )
}
