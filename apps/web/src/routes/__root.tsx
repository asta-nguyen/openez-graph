import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { AppSidebar } from "../components/sidebar";
import { SidebarProvider, TooltipProvider } from "@openez-graph/ui";
import { ThemeProvider } from "../lib/theme";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
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
              <Outlet />
            </main>
          </div>
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
