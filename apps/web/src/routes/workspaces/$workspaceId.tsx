import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/workspaces/$workspaceId")({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  return <Outlet />;
}
