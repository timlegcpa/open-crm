import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A state chip: deep text on a pale fill of the same hue, a pair the theme tunes for both
 * light and dark. Say what a thing IS (Active, Signed, Overdue). For "N things waiting" use
 * CountBadge; for a long column of statuses use StatusPill.
 *
 * - default:   not started, still yours (filled grey)
 * - neutral:   retired, stop looking at it (outline only, recessed)
 * - success / warning / error: done, needs care, failed
 * - caution / attention: the two warm in-between states (on me, waiting)
 * - review:    in review
 * - info:      informational, in the link blue
 */
const VARIANTS = {
  default: "bg-border text-muted-foreground",
  neutral: "bg-transparent text-muted-foreground ring-1 ring-inset ring-border",
  success: "bg-success-light text-success-dark",
  warning: "bg-warning-light text-warning-dark",
  error: "bg-destructive-light text-destructive-dark",
  caution: "bg-caution-light text-caution-dark",
  attention: "bg-attention-light text-attention-dark",
  review: "bg-review-light text-review-dark",
  info: "bg-link/10 text-link",
} as const

export type ToneBadgeVariant = keyof typeof VARIANTS

function ToneBadge({
  children,
  variant = "default",
  className,
  title,
}: {
  children: React.ReactNode
  variant?: ToneBadgeVariant
  className?: string
  title?: string
}) {
  return (
    <span
      className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-medium", VARIANTS[variant], className)}
      title={title}
    >
      {children}
    </span>
  )
}

export { ToneBadge }
