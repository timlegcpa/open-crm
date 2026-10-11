import * as React from "react"

import { cn } from "@/lib/utils"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

/**
 * THE small inline filter: All / Open / Done, Month / Quarter. It narrows what a panel is
 * already showing; switching a PAGE's sections is PageTabs. A filter never goes empty:
 * re-clicking the selected segment does nothing (Radix would emit ''), unless the caller
 * passes `onDeselect` for a single on/off segment.
 *
 *   <Segmented label="Status" value={status} onValueChange={setStatus}
 *     options={[{ value: "all", label: "All" }, { value: "open", label: "Open" }]} />
 *
 * The gap is set explicitly: shadcn's ToggleGroup base carries `gap-1`, which
 * tailwind-merge only replaces when a gap utility is given.
 */
const GROUP_CLASS = "inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5"

const ITEM_CLASS = [
  "h-6 rounded-sm border-0",
  "px-2.5 py-0 gap-1.5 text-xs font-medium whitespace-nowrap transition-colors",
  "bg-transparent text-muted-foreground hover:text-foreground",
  // A quiet raised fill, not the inverted --primary: a filter is a state, not a button.
  "data-[state=on]:bg-secondary data-[state=on]:text-foreground",
  "data-[state=on]:hover:bg-secondary data-[state=on]:hover:text-foreground",
  "disabled:cursor-not-allowed disabled:opacity-50",
  "[&_svg]:size-3.5",
].join(" ")

export interface SegmentedOption<T extends string> {
  value: T
  /** A node, so a segment can carry an icon beside its label. */
  label: React.ReactNode
  disabled?: boolean
  title?: string
}

export interface SegmentedProps<T extends string> {
  value: T
  onValueChange: (value: T) => void
  options: ReadonlyArray<SegmentedOption<T>>
  /** Names the group for assistive tech: "Status", "Period". */
  label?: string
  className?: string
  /** Only for a single on/off segment: called when the pressed segment is clicked again. */
  onDeselect?: () => void
}

function Segmented<T extends string>({ value, onValueChange, options, label, className, onDeselect }: SegmentedProps<T>) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as T)
        else onDeselect?.()
      }}
      aria-label={label}
      className={cn(GROUP_CLASS, className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          title={option.title}
          className={ITEM_CLASS}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export { Segmented }
