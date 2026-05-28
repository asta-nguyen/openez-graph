"use client";

import { SidebarTrigger } from "@openez-graph/ui";
import { ThemeToggle } from "./theme-toggle";

export function Header() {
  return (
    <header className="flex items-center justify-end gap-2 border-b border-border px-6 py-2">
      <SidebarTrigger />
      <ThemeToggle />
    </header>
  );
}
