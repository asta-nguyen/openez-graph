import type { ReactNode } from "react";
import "./globals.css";

const fontUrl =
  "https://fonts.googleapis.com/css2?family=Archivo+Black&family=Sora:wght@100..800&family=JetBrains+Mono:wght@400;600&display=swap";

export const metadata = {
  title: "OpenEZ Graph — Understand Your Codebase",
  description:
    "OpenEZ Graph indexes your local projects and turns them into searchable, explorable knowledge graphs — no cloud required.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={fontUrl} rel="stylesheet" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
