"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  target: number;
  duration?: number;
  suffix?: string;
  onDone?: () => void;
}

export function AnimatedCounter({ target, duration = 1200, suffix = "" }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const [val, setVal] = useState(0);
  const started = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const start = performance.now();
          const step = (now: number) => {
            const t = Math.min((now - start) / duration, 1);
            const ease = 1 - (1 - t) * (1 - t);
            setVal(Math.floor(ease * target));
            if (t < 1) requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
          observer.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    if (el.current) observer.observe(el.current);
    return () => observer.disconnect();
  }, [target, duration]);

  return (
    <div ref={el}>
      {val}{suffix}
    </div>
  );
}
