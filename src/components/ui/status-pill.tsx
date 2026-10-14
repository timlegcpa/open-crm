import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A quiet capsule with a coloured dot and a label. The DOT carries the status; the capsule
 * is the same neutral on every row, so a column of twenty pills reads as small type with a
 * rail of dots, not twenty tinted badges. Use ToneBadge instead when the tint itself is the
 * information (a stage chip).
 *
 * `dotClassName` is a background utility from the theme (`bg-success`, `bg-link`,
 * `bg-caution`, `bg-muted-foreground`), never a literal colour. `muted` dims a retired or
 * parked status.
 */
function StatusPill({
  children,
  dotClassName,
  muted = false,
  className,
  title,
}: {
  children: React.ReactNode
  dotClassName?: string
  muted?: boolean
  className?: string
  title?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-secondary px-2 text-[11px] font-medium",
        muted ? "text-muted-foreground" : "text-foreground",
        className
      )}
      title={title}
    >
      {dotClassName && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClassName)} aria-hidden="true" />}
      {children}
    </span>
  )
}

export { StatusPill }
