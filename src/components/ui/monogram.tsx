import { cn } from "@/lib/utils"

const SIZE = {
  sm: "h-[26px] w-[26px] text-[10px]",
  md: "h-7 w-7 text-[11px]",
  lg: "h-11 w-11 text-[17px]",
} as const

/**
 * Up to two initials for a name: "Ada Example" is "AE", "example studio" is "ES", an email
 * address uses its local part ("ada.example@x.test" is "AE"). Empty input gives "?".
 */
export function initialsOf(name: string | null | undefined): string {
  const source = (name ?? "").trim().split("@")[0]
  const words = source.split(/[\s._-]+/).filter(Boolean)
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
  return letters.join("") || "?"
}

/**
 * The initials disc every people list shares: a `--secondary` disc with a hairline ring.
 * Neutral by default; a caller with a status to show passes the tint through `className`.
 * Decorative by contract: the name is always beside it, so it is hidden from assistive tech
 * rather than read twice. `sm` suits a list row, `md` a board card, `lg` a record header.
 */
function Monogram({
  initials,
  size = "sm",
  className,
}: {
  initials: string
  size?: keyof typeof SIZE
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full bg-secondary font-semibold uppercase text-foreground ring-1 ring-inset ring-border",
        SIZE[size],
        className
      )}
    >
      {initials}
    </span>
  )
}

export { Monogram }
