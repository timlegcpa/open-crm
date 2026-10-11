import * as React from "react"

import { cn } from "@/lib/utils"
import { TabsList, TabsTrigger } from "@/components/ui/tabs"

/**
 * THE page-section switcher: an underline strip. A hairline under the whole run, each tab
 * plain 13px text, the selected tab in the foreground colour with a 2px rule on the
 * hairline, no fill anywhere. Filters inside a panel use Segmented instead: one says "where
 * am I", the other "what am I looking at".
 *
 * Radix Tabs (local state):
 *   <Tabs value={tab} onValueChange={setTab}>
 *     <PageTabsList><PageTabsTrigger value="overview">Overview</PageTabsTrigger></PageTabsList>
 *   </Tabs>
 *
 * Tabs that are ROUTES (each tab its own URL) are links, not Radix Tabs: give each
 * `<NavLink>` the PAGE_TAB_TRIGGER class and set `aria-selected` on the active one; the
 * selected look keys on `aria-selected`, so both forms read the same.
 */
export const PAGE_TABS_LIST =
  "flex w-full flex-shrink-0 items-center justify-start gap-0 h-auto overflow-x-auto rounded-none border-b border-border bg-transparent p-0"

export const PAGE_TAB_TRIGGER = [
  // `-mb-px` drops the 2px rule onto the list's hairline instead of above it.
  "relative -mb-px h-auto rounded-none border-b-2 border-transparent bg-transparent",
  "px-3 py-2 gap-1.5 text-[13px] font-medium whitespace-nowrap",
  "text-muted-foreground transition-colors hover:text-foreground",
  "aria-selected:border-foreground aria-selected:text-foreground",
  // Neutralise shadcn's raised-pill active look; same result as the aria-selected rule.
  "data-[state=active]:border-foreground data-[state=active]:bg-transparent",
  "data-[state=active]:text-foreground data-[state=active]:shadow-none",
  "[&_svg]:size-4",
].join(" ")

const PageTabsList = React.forwardRef<
  React.ElementRef<typeof TabsList>,
  React.ComponentPropsWithoutRef<typeof TabsList>
>(({ className, ...props }, ref) => <TabsList ref={ref} className={cn(PAGE_TABS_LIST, className)} {...props} />)
PageTabsList.displayName = "PageTabsList"

const PageTabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsTrigger>,
  React.ComponentPropsWithoutRef<typeof TabsTrigger>
>(({ className, ...props }, ref) => <TabsTrigger ref={ref} className={cn(PAGE_TAB_TRIGGER, className)} {...props} />)
PageTabsTrigger.displayName = "PageTabsTrigger"

export { PageTabsList, PageTabsTrigger }
