import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

type StatusTone = 'positive' | 'warning' | 'negative' | 'neutral'

interface StatusPillProps {
  label: string
  tone?: StatusTone
  className?: string
}

const TONE_STYLES: Record<StatusTone, string> = {
  positive: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300',
  negative: 'border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300',
  neutral: 'border-muted bg-muted/40 text-muted-foreground'
}

export function StatusPill({ label, tone = 'neutral', className }: StatusPillProps) {
  return (
    <Badge variant="outline" className={cn('max-w-full w-auto shrink whitespace-normal break-words text-center font-medium leading-tight', TONE_STYLES[tone], className)}>
      {label}
    </Badge>
  )
}
