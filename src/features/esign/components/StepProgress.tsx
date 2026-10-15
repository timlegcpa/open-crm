import { Check } from 'lucide-react';
import { ClickRegion } from '@/components/ui/click-region';
import { cn } from '@/lib/utils';

export interface ComposerStep {
  key: string;
  label: string;
}

/**
 * The composer's steps. A step is reachable when every step before it is satisfied; done
 * when it is behind the current one and still reachable. The current step is never a
 * button.
 */
export function StepProgress({
  steps,
  currentIndex,
  isReachable,
  onJump,
}: {
  steps: readonly ComposerStep[];
  currentIndex: number;
  isReachable: (index: number) => boolean;
  onJump: (index: number) => void;
}) {
  return (
    <ol className="mb-5 flex w-full flex-wrap items-center gap-x-2 gap-y-2" aria-label="Composer steps">
      {steps.map((step, i) => {
        const isCurrent = i === currentIndex;
        const reachable = isReachable(i);
        const isDone = i < currentIndex && reachable;
        const clickable = reachable && !isCurrent;
        return (
          <li key={step.key} className="flex min-w-0 flex-1 items-center">
            <ClickRegion
              disabled={!clickable}
              onClick={() => clickable && onJump(i)}
              aria-current={isCurrent ? 'step' : undefined}
              className="group flex min-w-0 items-center gap-2 rounded-md"
            >
              <span
                className={cn(
                  'inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold',
                  isCurrent && 'border-foreground bg-foreground text-background',
                  isDone && 'border-success bg-success text-primary-foreground',
                  !isCurrent && !isDone && 'border-border bg-card text-muted-foreground',
                )}
              >
                {isDone ? <Check className="size-3.5" aria-label="done" /> : i + 1}
              </span>
              <span
                className={cn(
                  'truncate text-sm',
                  isCurrent ? 'font-semibold text-foreground' : 'text-muted-foreground',
                  clickable && 'group-hover:text-foreground',
                )}
              >
                {step.label}
              </span>
            </ClickRegion>
            {i < steps.length - 1 && <div className={cn('mx-3 hidden h-px flex-1 sm:block', isDone ? 'bg-success' : 'bg-border')} aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}
