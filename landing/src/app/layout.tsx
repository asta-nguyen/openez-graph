import type { ReactNode } from "react";
import type { Metadata } from "next";
import { syne, sora, jetbrainsMono } from "@/lib/fonts";
import { getBaseUrl } from "@/lib/url";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const baseUrl = await getBaseUrl();
  return {
    metadataBase: new URL(baseUrl),
    title: {
      default: "OpenEZ Graph — Durable context for coding agents",
      template: "%s | OpenEZ Graph",
    },
    description:
      "Local-first code intelligence for coding agents: ranked retrieval, graph context, durable memory, and multi-workspace MCP tools on SQLite.",
    keywords: [
      "code intelligence",
      "code graph",
      "codebase indexing",
      "knowledge graph",
      "code search",
      "MCP",
      "SQLite",
      "local-first",
      "developer tools",
      "code navigation",
      "symbol lookup",
      "dependency graph",
      "open source",
    ],
    authors: [{ name: "OpenEZ Graph", url: baseUrl }],
    creator: "OpenEZ Graph",
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: "OpenEZ Graph",
      title: "OpenEZ Graph — Durable context for coding agents",
      description:
        "Ranked code retrieval, graph context, and durable project memory for Codex, Claude, OpenCode, Windsurf, and Devin.",
      url: baseUrl,
      images: [
        {
          url: "/og-animated",
          width: 1200,
          height: 630,
          alt: "OpenEZ Graph — Durable context for coding agents",
        },
      ],
    },
    alternates: {
      canonical: "/",
    },
    twitter: {
      card: "summary_large_image",
      title: "OpenEZ Graph — Durable context for coding agents",
      description:
        "Ranked code retrieval, graph context, and durable project memory for Codex, Claude, OpenCode, Windsurf, and Devin.",
      images: [
        {
          url: "/og-animated",
          width: 1200,
          height: 630,
          alt: "OpenEZ Graph — Durable context for coding agents",
        },
      ],
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-video-preview": -1,
        "max-image-preview": "large",
        "max-snippet": -1,
      },
    },
    icons: {
      icon: "/icon.png",
    },
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const baseUrl = await getBaseUrl();

  return (
    <html
      lang="en"
      className={`dark ${syne.variable} ${sora.variable} ${jetbrainsMono.variable}`}
    >
      <body className="antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "SoftwareApplication",
              name: "OpenEZ Graph",
              description:
                "Local-first code intelligence with ranked retrieval, graph context, durable memory, and multi-workspace MCP tools on SQLite.",
              url: baseUrl,
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Windows, macOS, Linux",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "USD",
              },
              author: {
                "@type": "Organization",
                name: "OpenEZ Graph",
                url: baseUrl,
              },
            }).replace(/</g, "\\u003c"),
          }}
        />
        {children}
      </body>
    </html>
  );
}
