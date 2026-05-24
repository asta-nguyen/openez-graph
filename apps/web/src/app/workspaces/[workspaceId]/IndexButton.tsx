"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@openez-graph/ui";
import { Play, Loader2 } from "lucide-react";

interface IndexButtonProps {
  workspaceId: string;
  disabled?: boolean;
  variant?: "default" | "secondary" | "outline" | "ghost" | "destructive";
}

export function IndexButton({ workspaceId, disabled, variant = "default" }: IndexButtonProps) {
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleIndex = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/index`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        const error = await response.json();
        if (response.status === 409 && error.existingJob) {
          throw new Error(
            error.error ?? `A job is already ${error.existingJob.status} for this workspace`
          );
        }
        throw new Error(error.error ?? "Failed to start indexing");
      }

      // Refresh the page to show updated status
      router.refresh();
    } catch (error) {
      console.error("Indexing failed:", error);
      alert(error instanceof Error ? error.message : "Failed to start indexing");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button disabled={disabled || loading} onClick={handleIndex}>
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Play className="h-4 w-4" />
      )}
      Index Workspace
    </Button>
  );
}
