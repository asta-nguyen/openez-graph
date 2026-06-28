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
      default: "OpenEZ Graph — Understand Your Codebase",
      template: "%s | OpenEZ Graph",
    },
    description:
      "OpenEZ Graph indexes your local projects and turns them into searchable, explorable knowledge graphs — no cloud required.",
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
      title: "OpenEZ Graph — Understand Your Codebase",
      description:
        "A local-first code intelligence engine that indexes your projects into a searchable knowledge graph — no cloud, no Postgres, no setup friction.",
      url: baseUrl,
      images: [
        {
          url: "/og-animated",
          width: 1200,
          height: 630,
          alt: "OpenEZ Graph — Understand Your Codebase",
        },
      ],
    },
    alternates: {
      canonical: "/",
    },
    twitter: {
      card: "summary_large_image",
      title: "OpenEZ Graph — Understand Your Codebase",
      description:
        "A local-first code intelligence engine that indexes your projects into a searchable knowledge graph — no cloud, no Postgres, no setup friction.",
      images: [
        {
          url: "/og-animated",
          width: 1200,
          height: 630,
          alt: "OpenEZ Graph — Understand Your Codebase",
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
                "A local-first code intelligence engine that indexes your projects into a searchable knowledge graph — no cloud, no Postgres, no setup friction.",
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
