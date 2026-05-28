import "./globals.css";

import type { ReactNode } from "react";

import { TooltipProvider, SidebarProvider } from "@openez-graph/ui";
import { ThemeProvider } from "next-themes";
import { AppSidebar } from "../components/sidebar";
import { Geist } from "next/font/google";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata = {
  title: "OpenEZ Graph",
  description: "Local memory graph dashboard"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={geist.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <TooltipProvider>
            <SidebarProvider>
              <div className="flex h-svh w-full overflow-hidden">
                <AppSidebar />
                <main className="flex-1 overflow-y-auto bg-background p-6">
                  {children}
                </main>
              </div>
            </SidebarProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}