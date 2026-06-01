"use client";

import { useEffect, useRef, useState } from "react";

interface TypewriterProps {
  lines: string[];
  className?: string;
  speed?: number;
}

export function Typewriter({ lines, className, speed = 60 }: TypewriterProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [started, setStarted] = useState(false);
  const [visibleLines, setVisibleLines] = useState(0);
  const [typingChars, setTypingChars] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setStarted(true);
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!started) return;

    if (visibleLines >= lines.length) {
      setDone(true);
      return;
    }

    const currentLine = lines[visibleLines];
    if (typingChars < currentLine.length) {
      const timer = setTimeout(() => setTypingChars((c) => c + 1), speed);
      return () => clearTimeout(timer);
    } else {
      const timer = setTimeout(() => {
        setVisibleLines((v) => v + 1);
        setTypingChars(0);
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [started, visibleLines, typingChars, lines, speed]);

  return (
    <div ref={ref} className={className}>
      {lines.map((line, i) => (
        <div key={i} className="flex items-start gap-3">
          <span className="text-primary shrink-0 select-none mt-0.5">$</span>
          <code className="text-foreground text-xs sm:text-sm leading-relaxed">
            {i < visibleLines
              ? line
              : i === visibleLines
                ? line.slice(0, typingChars)
                : ""}
          </code>
        </div>
      ))}
      {!done && started && (
        <div className="flex items-center gap-3">
          <span className="text-primary shrink-0 select-none">$</span>
          <span className="inline-block w-2 h-4 bg-primary animate-pulse" />
        </div>
      )}
    </div>
  );
}
