// A row of mutually exclusive choices, with the selection sliding to the
// one picked rather than blinking there.
//
// The slide is the point: it says "this replaced that" in the one place
// the eye is already looking. It is a shared layout animation keyed per
// instance, so two controls on one page never trade indicators.
import { useId } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string | undefined> {
  value: T;
  label: React.ReactNode;
  /** For an icon-only or abbreviated label. */
  title?: string;
}

export function Segmented<T extends string | undefined>({
  value,
  options,
  onChange,
  className,
  size = "md",
  "aria-label": ariaLabel,
}: {
  value: T;
  options: Array<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("flex gap-0.5 rounded-[10px] bg-muted p-0.5", className)}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={String(option.value ?? "default")}
            role="radio"
            aria-checked={on}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg font-medium outline-none transition-colors duration-150",
              size === "sm" ? "px-2.5 py-1 text-[12px]" : "px-3 py-1.5 text-[12.5px]",
              on ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {on && (
              <motion.span
                layoutId={`segment-${id}`}
                transition={{ type: "spring", duration: 0.25, bounce: 0 }}
                className="absolute inset-0 rounded-lg bg-background shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_0.5px_rgba(255,255,255,0.08)]"
              />
            )}
            <span className="relative flex items-center gap-1.5">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
