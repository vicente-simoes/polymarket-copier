import { Button } from '@/components/ui/button'

interface PaginationControlsProps {
  page: number
  totalPages: number
  onPageChange: (nextPage: number) => void
  className?: string
}

export function PaginationControls({ page, totalPages, onPageChange, className }: PaginationControlsProps) {
  const canGoPrevious = page > 1
  const canGoNext = page < totalPages

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="min-h-9" disabled={!canGoPrevious} onClick={() => onPageChange(1)}>
          First
        </Button>
        <Button variant="outline" size="sm" className="min-h-9" disabled={!canGoPrevious} onClick={() => onPageChange(page - 1)}>
          Previous
        </Button>
        <Button variant="outline" size="sm" className="min-h-9" disabled={!canGoNext} onClick={() => onPageChange(page + 1)}>
          Next
        </Button>
      </div>
      <p className="w-full text-xs text-muted-foreground sm:w-auto">
        Page {page} of {Math.max(totalPages, 1)}
      </p>
    </div>
  )
}
