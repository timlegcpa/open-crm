import * as React from "react"
import { Calendar as CalendarIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { formatDate, formatMonthYear, parseDateOnly, toISODate } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

/**
 * THE date field: a button showing the date, opening the Calendar in a Popover. Never a
 * native `<input type="date">`, which draws the operating system's picker and ignores the
 * theme.
 *
 * The value is an ISO string in and out, never a Date: `YYYY-MM-DD` (or `YYYY-MM` with
 * `monthOnly`), exactly what a Postgres `date` column holds. An empty or unparseable value
 * shows the placeholder. Clicking the selected day again clears it, and `onChange`
 * receives `''`; turn that into `null` before it reaches the database.
 *
 *   <Label htmlFor="due">Due</Label>
 *   <DatePicker id="due" value={dueOn} onChange={(v) => setDueOn(v || null)} />
 */
export interface DatePickerProps {
  /** `YYYY-MM-DD` (`YYYY-MM` with monthOnly), or '' / null when unset. */
  value: string | null | undefined
  /** Receives `YYYY-MM-DD` (`YYYY-MM` with monthOnly), or '' when cleared. */
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /** Width and size classes for the trigger. */
  className?: string
  id?: string
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-invalid"?: boolean
  /** Pick a month (stored as `YYYY-MM`, displayed "April 2026"). */
  monthOnly?: boolean
  /** Extra Calendar options: `disabled` matchers, `captionLayout="dropdown"` with `startMonth`/`endMonth`. */
  calendar?: Omit<React.ComponentProps<typeof Calendar>, "mode" | "selected" | "onSelect" | "required">
  /** On the trigger, for a grid cell that commits on Enter or blur. */
  onKeyDown?: (event: React.KeyboardEvent<HTMLButtonElement>) => void
  onBlur?: () => void
  onFocus?: () => void
}

function DatePicker({
  value,
  onChange,
  placeholder = "Pick a date",
  disabled,
  className,
  id,
  monthOnly,
  calendar,
  onKeyDown,
  onBlur,
  onFocus,
  ...aria
}: DatePickerProps) {
  const [open, setOpen] = React.useState(false)
  // Opening moves focus into the popover, which blurs the trigger AFTER onOpenChange(true).
  // That one blur is not the user leaving the field, so it is swallowed here; a caller that
  // commits on blur only ever sees a real exit. (Closing returns focus to the trigger.)
  const suppressNextBlur = React.useRef(false)
  const selected = parseDateOnly(value) ?? undefined
  const display = selected ? (monthOnly ? formatMonthYear(selected) : formatDate(selected)) : placeholder

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          suppressNextBlur.current = true
          onFocus?.()
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          disabled={disabled}
          onKeyDown={onKeyDown}
          onBlur={() => {
            if (suppressNextBlur.current) {
              suppressNextBlur.current = false
              return
            }
            onBlur?.()
          }}
          onFocus={onFocus}
          aria-label={aria["aria-label"]}
          aria-labelledby={aria["aria-labelledby"]}
          aria-invalid={aria["aria-invalid"]}
          className={cn(
            "h-9 justify-start gap-2 px-3 text-sm font-normal [&_svg]:size-4",
            !selected && "text-muted-foreground",
            className
          )}
        >
          <CalendarIcon aria-hidden="true" />
          {display}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          {...calendar}
          mode="single"
          selected={selected}
          defaultMonth={selected ?? calendar?.defaultMonth}
          onSelect={(day) => {
            const iso = day ? toISODate(day) : ""
            onChange(monthOnly ? iso.slice(0, 7) : iso)
            setOpen(false)
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  )
}

export { DatePicker }
