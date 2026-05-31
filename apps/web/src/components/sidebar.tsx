import { Link, useMatchRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard,
  FolderKanban,
  Settings,
  Database,
  FileText,
  ScrollText,
} from "lucide-react";
import {
  dashboardQueryOptions,
  documentsQueryOptions,
  jobsQueryOptions,
  settingsEnvQueryOptions,
  workspacesQueryOptions,
} from "../lib/queries";
import { PAGE_SIZE } from "../lib/pagination";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
} from "@openez-graph/ui";
import { ThemeToggle } from "./theme-toggle";

const mainNav = [
  { href: "/", label: "Overview", icon: LayoutDashboard, query: dashboardQueryOptions },
  { href: "/workspaces", label: "Workspaces", icon: FolderKanban, query: workspacesQueryOptions },
];

const debugNav = [
  { href: "/query", label: "Query", icon: ScrollText },
  { href: "/documents", label: "Documents", icon: FileText, query: () => documentsQueryOptions(1, PAGE_SIZE) },
  { href: "/jobs", label: "Jobs", icon: Database, query: jobsQueryOptions },
];

const secondaryNav = [
  { href: "/settings", label: "Settings", icon: Settings, query: settingsEnvQueryOptions },
];

function NavLink({ href, label, icon: Icon, query }: { href: string; label: string; icon: React.ComponentType<{ className?: string }>; query?: any }) {
  const queryClient = useQueryClient();
  const match = useMatchRoute();
  const isActive = match({ to: href, fuzzy: href !== "/" });

  const handleMouseEnter = () => {
    if (!query) return;
    const options = typeof query === "function" ? query() : query;
    queryClient.prefetchQuery(options);
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={!!isActive} tooltip={label}>
        <Link to={href} onMouseEnter={handleMouseEnter}>
          <Icon className="h-4 w-4" />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-1 group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:items-center">
              <SidebarMenuButton asChild size="lg" tooltip="OpenEZ Graph">
                <Link to="/" className="flex items-center gap-3">
                  <img src="/logo.png" alt="OpenEZ Graph" className="h-8 w-8 rounded-lg" />
                  <div className="flex flex-col gap-0 group-data-[collapsible=icon]:hidden">
                    <span className="text-sm font-semibold">OpenEZ Graph</span>
                    <span className="text-xs text-muted-foreground">Local indexing</span>
                  </div>
                </Link>
              </SidebarMenuButton>
              <SidebarTrigger />
              <ThemeToggle />
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNav.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupLabel>Debug</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {debugNav.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarSeparator />

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {secondaryNav.map((item) => (
                <NavLink key={item.href} {...item} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="px-3 py-2 group-data-[collapsible=icon]:hidden">
          <p className="text-xs text-muted-foreground">
            Workspace config, retrieval debugging, graph inspection.
          </p>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
