"use server";

import { memoryQuery } from "@openez-graph/core";

export async function runQuery(
  _previousState: {
    answerContext: string;
    sources: Array<{ path: string; startLine?: number; endLine?: number; score: number; reason: string }>;
    error: string | null;
  },
  formData: FormData
) {
  const workspaceId = String(formData.get("workspaceId") ?? "").trim();
  const query = String(formData.get("query") ?? "");

  if (!workspaceId) {
    return {
      answerContext: "",
      sources: [],
      error: "Workspace ID is required."
    };
  }

  if (!query.trim()) {
    return {
      answerContext: "",
      sources: [],
      error: "Query is required."
    };
  }

  try {
    const result = await memoryQuery({
      workspaceId,
      query
    });

    return {
      ...result,
      error: null
    };
  } catch (error) {
    return {
      answerContext: "",
      sources: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
