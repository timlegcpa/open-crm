import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { NO_VALUE_TEXT } from "@/lib/format"
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard"

/**
 * A value you copy by clicking THE VALUE. The text itself is the button: a click copies
 * it, and a green check appears beside it for a moment. There is no separate "Copy" link or
 * icon button. Nothing to copy (null, empty, a dash) renders the no-value glyph as plain
 * text, never a button that would copy a dash.
 *
 *   <CopyValue value={contact.email} label="email" />
 *   <CopyValue value={account.id} label="account ID" className="font-mono" />
 *
 * `label` names the value for screen readers ("Copy email"); the check is announced as
 * "Copied". A copy the browser refused (an insecure origin, a denied permission) shows no
 * check, so the mark never claims a copy that did not happen.
 */
export interface CopyValueProps {
  value: string | null | undefined
  /** What the value is, for assistive tech: "email", "phone", "link". */
  label: string
  /** What to show instead of the raw value (a formatted phone number); the raw value is copied. */
  children?: React.ReactNode
  className?: string
}

function CopyValue({ value, label, children, className }: CopyValueProps) {
  const { copy, copiedKey } = useCopyToClipboard()
  const text = (value ?? "").trim()

  if (!text || /^[–—-]+$/.test(text)) {
    return <span className={cn("text-muted-foreground", className)}>{NO_VALUE_TEXT}</span>
  }

  const copied = copiedKey === text
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <button
        type="button"
        onClick={(event) => {
          // Inside a clickable row, a copy is not also a row click.
          event.stopPropagation()
          void copy(text)
        }}
        title={copied ? "Copied" : "Click to copy"}
        aria-label={`Copy ${label}: ${text}`}
        className={cn(
          "min-w-0 truncate rounded-sm text-left underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className
        )}
      >
        {children ?? text}
      </button>
      <span aria-live="polite" className="inline-flex shrink-0">
        {copied && (
          <>
            <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
            <span className="sr-only">Copied</span>
          </>
        )}
      </span>
    </span>
  )
}

export { CopyValue }
