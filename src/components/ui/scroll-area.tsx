import * as React from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"

import { cn } from "@/lib/utils"

/**
 * THE scroll region. Every pane, list or panel that scrolls uses this, so every scrollbar in
 * the app is the same: 10px wide, a transparent track, a rounded thumb in the border colour.
 * (Primitives that own their scroller, such as a Select's list or a Command list, get the
 * same look from the global scrollbar rules in `index.css`.)
 *
 * Give it a bounded height (`h-full` inside a flex column with `min-h-0`, or a fixed `h-*`),
 * or there is nothing to scroll.
 */
interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  /**
   * Constrain content to the viewport's width; pass it for a list that only scrolls
   * vertically. Radix wraps children in a `display: table` box so content CAN grow wider
   * than the viewport (that is what makes horizontal scrolling work), and inside a table box
   * `w-full` children size to the longest row, so `truncate` never fires and rows overflow
   * sideways instead. `fitWidth` sets that wrapper back to `block`.
   */
  fitWidth?: boolean
  /** Also show a horizontal scrollbar, for content wider than the pane (a wide table). */
  horizontal?: boolean
}

const ScrollArea = React.forwardRef<React.ElementRef<typeof ScrollAreaPrimitive.Root>, ScrollAreaProps>(
  ({ className, children, fitWidth, horizontal, ...props }, ref) => (
    <ScrollAreaPrimitive.Root ref={ref} className={cn("relative overflow-hidden", className)} {...props}>
      <ScrollAreaPrimitive.Viewport className={cn("h-full w-full rounded-[inherit]", fitWidth && "[&>div]:!block")}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      {horizontal && <ScrollBar orientation="horizontal" />}
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
)
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none bg-transparent transition-colors",
      orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent p-[1px]",
      orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent p-[1px]",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
))
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea, ScrollBar }
