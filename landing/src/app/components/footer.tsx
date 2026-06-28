"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { Github } from "lucide-react";

const ParticleText = dynamic(
  () => import("./particle-text").then((m) => m.ParticleText),
  { ssr: false },
);

const navLinks = [
  { label: "GitHub", href: "https://github.com/asta-nguyen/openez-graph" },
  { label: "Docs", href: "https://github.com/asta-nguyen/openez-graph#readme" },
  { label: "CLI", href: "https://github.com/asta-nguyen/openez-graph#cli" },
  { label: "MCP", href: "https://github.com/asta-nguyen/openez-graph#mcp" },
];

// OpenEZ accent colors in linear RGB (0–1)
const TEXT_COLOR: [number, number, number] = [0.97, 0.97, 0.98];
const CYAN_BRIGHT: [number, number, number] = [0.55, 0.92, 0.98];
const CYAN_ACCENT: [number, number, number] = [0.3, 0.75, 0.87];

export function Footer() {
  return (
    <footer className="openez-footer">
      {/* Full-footer particle canvas — "OPENEZ" centered, hover anywhere */}
      <ParticleText
        text="OPENEZ"
        gradientPart="EZ"
        particleCount={20000}
        ambient={0}
        color={TEXT_COLOR}
        gradientFrom={CYAN_BRIGHT}
        gradientTo={CYAN_ACCENT}
        weight={800}
        fontSize={64}
        cursorRadiusScale={0.4}
        fillContainer
        verticalAlign="top"
        hoverMode={36}
        entranceMode={0}
        className="openez-footer__particles-full"
      />

      {/* Soft top glow line */}
      <div className="openez-footer__topline" />

      {/* Content overlaid on top of the particle field */}
      <div className="openez-footer__content">
        {/* Spacer — leaves room for the centered wordmark visual */}
        <div className="openez-footer__wordmark-space" />

        {/* Nav links + social icons */}
        <div className="openez-footer__mid">
          <nav className="openez-footer__nav">
            {navLinks.map((l) => (
              <a
                key={l.label}
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                className="openez-footer__navlink"
              >
                {l.label}
              </a>
            ))}
          </nav>

          <div className="openez-footer__social">
            <a
              href="https://unikorn.vn/p/kamehadb"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Unikorn"
              className="openez-footer__social-icon"
            >
              <Image
                src="/unikorn.svg"
                alt="Unikorn"
                width={16}
                height={16}
                className="openez-footer__unikorn-social"
              />
            </a>
            <a
              href="https://github.com/asta-nguyen/openez-graph"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              className="openez-footer__social-icon"
            >
              <Github className="h-4 w-4" />
            </a>
          </div>
        </div>

        {/* Tagline + copyright */}
        <div className="openez-footer__bottom">
          <span className="openez-footer__tagline">
            Local-first code intelligence — index once, query forever.
          </span>
          <span className="openez-footer__copy">
            MIT licensed · © {new Date().getFullYear()} OpenEZ Graph
          </span>
        </div>
      </div>
    </footer>
  );
}
