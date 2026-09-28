import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        // Admin-density sizes. The ledger/CRM surfaces run 7-8px shorter than
        // the public site, and every one of these carries its own
        // `[&_svg]:size-*`: the BASE class sets `[&_svg]:size-4`, which is a
        // descendant selector and therefore beats a `w-3 h-3` sitting directly
        // on the icon. Without these, adopting Button would silently grow every
        // small icon in admin from 12px to 16px.
        //
        // They use `rounded-md` (= `var(--radius) - 2px`), NOT Tailwind's plain
        // `rounded`, which is a FIXED 4px. Under stock shadcn's 0.5rem radius
        // those two differ by 2px and nobody notices; the admin theme set
        // `--radius: 0.75rem` from 2026-08 to 2026-09-18 (now 0.5rem, authored
        // in scripts/tweakcn-theme.css), which made `rounded-md` 10px and left
        // `rounded` at 4px — a gap that rendered a row's Finalize button as a
        // different SHAPE from the toolbar's Finalize All right above it (first
        // seen at the export's original 1.3rem, where the gap was 14.8px). A
        // theme may move `--radius` again; the rule below is what holds.
        // Any new size added here must use a radius token, never a literal.
        xs: "h-7 rounded-md px-2 text-xs gap-1 [&_svg]:size-3",
        "icon-xs": "h-6 w-6 rounded-md [&_svg]:size-3",
        "icon-sm": "h-7 w-7 rounded-md [&_svg]:size-3.5",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      (<Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props} />)
    );
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
