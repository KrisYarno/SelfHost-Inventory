import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { toneClasses } from "@/components/ui/tone-classes"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary/90 text-primary-foreground shadow hover:bg-primary",
        secondary:
          "border border-border/60 bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/85",
        outline: "text-foreground border-border bg-transparent hover:bg-muted",
        // Facelift F1-2: state colour rides the shared tones (readable text on
        // a muted fill in both themes), not a fill colour under white text.
        warning: toneClasses.warning,
        success: toneClasses.positive,
        info: toneClasses.info,
        muted:
          "border border-border/50 bg-muted text-muted-foreground",
        ghost:
          "border-transparent hover:bg-accent hover:text-accent-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
