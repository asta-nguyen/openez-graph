"use client";

import { useState } from "react";
import { CommandBox } from "./command-box";

const agents = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
  { id: "opencode", label: "OpenCode" },
  { id: "windsurf", label: "Windsurf" },
  { id: "devin", label: "Devin" },
];

export function AgentTabs({
  prefix,
  suffix = "",
  centered = false,
}: {
  prefix: string;
  suffix?: string;
  centered?: boolean;
}) {
  const [agent, setAgent] = useState(agents[0].id);

  return (
    <div>
      <div
        role="group"
        aria-label="Choose your agent"
        className={`mb-2 flex flex-wrap gap-1.5 ${centered ? "justify-center" : ""}`}
      >
        {agents.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={a.id === agent}
            onClick={() => setAgent(a.id)}
            className="agent-chip"
          >
            {a.label}
          </button>
        ))}
      </div>
      <CommandBox command={`${prefix} ${agent}${suffix}`} />
    </div>
  );
}
