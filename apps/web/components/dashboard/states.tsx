import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface StateCardProps {
  title: string
  description: string
  actionLabel?: string
  onAction?: () => void
}

const stateCardClass = 'rounded-2xl border border-white/10 bg-[#0D0D0D]/95 text-[#E7E7E7] shadow-[0_0_0_1px_rgba(255,255,255,0.02)] backdrop-blur'
const stateDescriptionClass = 'text-[#919191]'
const stateButtonClass = 'rounded-xl border-white/10 bg-white/[0.02] text-[#E7E7E7] hover:bg-white/[0.06] hover:text-white'

export function LoadingState({ title = 'Loading', description = 'Fetching dashboard data...' }: Partial<StateCardProps>) {
  return (
    <Card className={stateCardClass}>
      <CardHeader>
        <CardTitle className="text-[#E7E7E7]">{title}</CardTitle>
        <CardDescription className={stateDescriptionClass}>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-2 w-40 animate-pulse rounded-full bg-white/10" />
      </CardContent>
    </Card>
  )
}

export function ErrorState({ title, description, actionLabel, onAction }: StateCardProps) {
  return (
    <Card className={stateCardClass}>
      <CardHeader>
        <CardTitle className="text-[#E7E7E7]">{title}</CardTitle>
        <CardDescription className={stateDescriptionClass}>{description}</CardDescription>
      </CardHeader>
      {actionLabel && onAction ? (
        <CardContent>
          <Button variant="outline" className={stateButtonClass} onClick={onAction}>
            {actionLabel}
          </Button>
        </CardContent>
      ) : null}
    </Card>
  )
}

export function EmptyState({ title, description, actionLabel, onAction }: StateCardProps) {
  return (
    <Card className={stateCardClass}>
      <CardHeader>
        <CardTitle className="text-[#E7E7E7]">{title}</CardTitle>
        <CardDescription className={stateDescriptionClass}>{description}</CardDescription>
      </CardHeader>
      {actionLabel && onAction ? (
        <CardContent>
          <Button variant="outline" className={stateButtonClass} onClick={onAction}>
            {actionLabel}
          </Button>
        </CardContent>
      ) : null}
    </Card>
  )
}
