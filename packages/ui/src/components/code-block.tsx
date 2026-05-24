import { type HTMLAttributes } from "react";

import { cn } from "../lib/cn";

const CodeBlock = ({ className, children, ...props }: HTMLAttributes<HTMLPreElement>) => (
  <pre
    className={cn(
      "rounded-lg border bg-card/50 p-4 overflow-auto text-sm font-mono text-foreground leading-relaxed",
      className
    )}
    {...props}
  >
    {children}
  </pre>
);

export { CodeBlock };
