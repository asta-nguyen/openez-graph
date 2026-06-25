import type { ReactNode } from "react";
import type { Metadata } from "next";
import { syne, sora, jetbrainsMono } from "@/lib/fonts";
import { getBaseUrl } from "@/lib/url";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const baseUrl = await getBaseUrl();
  return {
    metadataBase: new URL(baseUrl),
    title: "OpenEZ Graph — Understand Your Codebase",
    description:
      "OpenEZ Graph indexes your local projects and turns them into searchable, explorable knowledge graphs — no cloud required.",
    openGraph: {
      type: "website",
      siteName: "OpenEZ Graph",
      title: "OpenEZ Graph — Understand Your Codebase",
      description:
        "A local-first code intelligence engine that indexes your projects into a searchable knowledge graph — no cloud, no Postgres, no setup friction.",
      url: baseUrl,
    },
    twitter: {
      card: "summary_large_image",
      title: "OpenEZ Graph — Understand Your Codebase",
      description:
        "A local-first code intelligence engine that indexes your projects into a searchable knowledge graph — no cloud, no Postgres, no setup friction.",
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${syne.variable} ${sora.variable} ${jetbrainsMono.variable}`}
    >
      <body className="antialiased">{children}</body>
    </html>
  );
}
