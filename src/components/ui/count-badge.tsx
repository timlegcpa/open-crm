import { cn } from "@/lib/utils"

/**
 * THE attention count: unread messages, unreviewed documents, answers waiting. It says
 * "N things here are waiting on you", so it is red by default (`tone="alert"`); a plain
 * tally with nothing owed (`tone="neutral"`) uses the same chip in grey, so the red keeps
 * its meaning. Renders nothing at zero, so call sites need no `> 0` guard. Over 99 it
 * reads "99+".
 *
 * A nav badge (`badge` on a nav item in a feature manifest) renders one of these.
 */
const TONES = {
  alert: "bg-destructive text-destructive-foreground",
  neutral: "bg-muted text-foreground",
} as const

function CountBadge({
  value,
  tone = "alert",
  className,
  title,
}: {
  value: number | null | undefined
  tone?: keyof typeof TONES
  className?: string
  /** Say what the number counts ("Unread messages"); it is the native tooltip and the accessible name. */
  title?: string
}) {
  if (!value || value <= 0) return null
  return (
    <span
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none tabular-nums",
        TONES[tone],
        className
      )}
      title={title}
      aria-label={title ? `${title}: ${value}` : undefined}
    >
      {value > 99 ? "99+" : value}
    </span>
  )
}

export { CountBadge }
