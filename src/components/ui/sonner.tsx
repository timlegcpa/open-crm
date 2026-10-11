import type { ComponentProps, CSSProperties } from "react"
import { Toaster as Sonner, toast } from "sonner"

/**
 * THE toast. `<Toaster />` is mounted once, at the root (App.tsx), for every audience; call
 * `toast` from anywhere:
 *
 *   toast.success("Contact saved.")
 *   toast.error(err.message)          // an EdgeError's message is always safe to show
 *   toast("Link copied.")
 *
 * Colours are the theme tokens, so a toast follows light and dark with the page. A toast is
 * a receipt, never the only place an error lives: a failure the user must act on is shown
 * inline, next to what failed.
 */
function Toaster(props: ComponentProps<typeof Sonner>) {
  return (
    <Sonner
      position="bottom-right"
      duration={5000}
      className="toaster group"
      style={
        {
          "--normal-bg": "hsl(var(--popover))",
          "--normal-text": "hsl(var(--popover-foreground))",
          "--normal-border": "hsl(var(--border))",
          "--border-radius": "var(--radius)",
        } as CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "font-sans text-[13px] shadow-lg",
          description: "text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground",
          cancelButton: "!bg-muted !text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
