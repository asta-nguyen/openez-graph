"use client";

import * as React from "react";
import { cn } from "../../lib/utils";

interface DualRangeSliderProps {
  min: number;
  max: number;
  step?: number;
  value: [number, number];
  onValueChange: (value: [number, number]) => void;
  className?: string;
}

/**
 * A dual-handle range slider built from two overlapping native range inputs.
 * Avoids adding @radix-ui/react-slider as a dependency.
 */
const DualRangeSlider = React.forwardRef<HTMLDivElement, DualRangeSliderProps>(
  ({ min, max, step = 1, value, onValueChange, className }, ref) => {
    const [minVal, maxVal] = value;

    const handleMinChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = Math.min(Number(e.target.value), maxVal - step);
      onValueChange([next, maxVal]);
    };

    const handleMaxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = Math.max(Number(e.target.value), minVal + step);
      onValueChange([minVal, next]);
    };

    const range = max - min;
    const minPos = range > 0 ? ((minVal - min) / range) * 100 : 0;
    const maxPos = range > 0 ? ((maxVal - min) / range) * 100 : 100;

    return (
      <div ref={ref} className={cn("relative h-5 w-full", className)}>
        <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-muted" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-primary"
          style={{ left: `${minPos}%`, right: `${100 - maxPos}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={minVal}
          onChange={handleMinChange}
          aria-label="Minimum value"
          className="pointer-events-none absolute top-0 z-20 h-5 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-background"
          style={{ zIndex: minVal > max - maxVal ? 5 : 20 }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={maxVal}
          onChange={handleMaxChange}
          aria-label="Maximum value"
          className="pointer-events-none absolute top-0 z-20 h-5 w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:pointer-events-auto [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-primary [&::-webkit-slider-thumb]:bg-background [&::-moz-range-thumb]:pointer-events-auto [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-primary [&::-moz-range-thumb]:bg-background"
        />
      </div>
    );
  },
);

DualRangeSlider.displayName = "DualRangeSlider";

export { DualRangeSlider };
