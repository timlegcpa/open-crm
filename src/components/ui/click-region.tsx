import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A click target that is not button-SHAPED: a whole row, a card, a list item, an inline-edit
 * display. It supplies semantics only (a real `<button type="button">`, the focus ring,
 * disabled handling, left-aligned text) and no geometry: no padding, radius, height or
 * hover fill. The caller brings the layout. If it ever needs geometry, that is a Button
 * variant, not this.
 */
const ClickRegion = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
)
ClickRegion.displayName = "ClickRegion"

export { ClickRegion }
