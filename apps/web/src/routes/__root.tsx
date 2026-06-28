import { createRootRouteWithContext, Outlet, redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppSidebar } from "../components/sidebar";
import { WorkspaceSelector } from "../components/workspace-selector";
import { SidebarProvider, TooltipProvider } from "@openez-graph/ui";
import { ThemeProvider } from "../lib/theme";
import type { WorkspaceListItem } from "../lib/api";
import { workspacesQueryOptions } from "../lib/queries";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
  workspace: WorkspaceListItem | null;
}>()({
  validateSearch: (search: Record<string, string | undefined>) => ({
    workspaceId: search.workspaceId ?? "",
  }),
  beforeLoad: async ({ context, location }) => {
    const workspaceId =
      (location.search as { workspaceId?: string }).workspaceId ?? "";
    await context.queryClient.ensureQueryData(workspacesQueryOptions);
    const result = context.queryClient.getQueryData<{
      ok: boolean;
      data: WorkspaceListItem[];
    }>(workspacesQueryOptions.queryKey);
    const workspaces = result?.data ?? [];

    let foundWorkspace: WorkspaceListItem | null = null;
    if (workspaceId) {
      foundWorkspace =
        workspaces.find((w) => w.id === workspaceId) ?? null;
    }
    if (!foundWorkspace && workspaces.length > 0) {
      // Default to most-recently-indexed (sort by lastIndexedAt descending);
      // when all lastIndexedAt are null, stable sort preserves data[0].
      const sorted = [...workspaces].sort((a, b) => {
        const aTime = a.lastIndexedAt
          ? new Date(a.lastIndexedAt).getTime()
          : 0;
        const bTime = b.lastIndexedAt
          ? new Date(b.lastIndexedAt).getTime()
          : 0;
        return bTime - aTime;
      });
      foundWorkspace = sorted[0] ?? null;
    }

    // If no workspaceId in URL but we found a default, redirect to set it.
    // This ensures all pages can read workspaceId from the URL search params.
    if (!workspaceId && foundWorkspace) {
      throw redirect({
        to: location.pathname,
        search: (prev) => ({ ...prev, workspaceId: foundWorkspace.id }),
        replace: true,
      });
    }

    return { workspace: foundWorkspace };
  },
  component: RootLayout,
});

function RootLayout() {
  return (
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <SidebarProvider>
          <div className="flex h-svh w-full overflow-hidden">
            <AppSidebar />
            <main className="flex-1 overflow-y-auto bg-background p-6">
              <div className="flex items-center justify-between mb-4">
                <WorkspaceSelector />
              </div>
              <Outlet />
            </main>
          </div>
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
