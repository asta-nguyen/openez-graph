"use client";

import { useRouter } from "next/navigation";

import { Button } from "@openez-graph/ui";
import { GitBranch } from "lucide-react";

interface GraphButtonProps {
  workspaceId: string;
  disabled?: boolean;
}

export function GraphButton({ workspaceId, disabled }: GraphButtonProps) {
  const router = useRouter();

  const handleBuildGraph = async () => {
    router.push(`/workspaces/${workspaceId}/graph`);
  };

  return (
    <Button variant="secondary" disabled={disabled} onClick={handleBuildGraph}>
      <GitBranch className="h-4 w-4" />
      Open Graph
    </Button>
  );
}
