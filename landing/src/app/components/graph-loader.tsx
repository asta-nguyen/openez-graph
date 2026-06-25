"use client";

import dynamic from "next/dynamic";

const DynamicHeroGraph = dynamic(
  () => import("./hero-graph").then((m) => ({ default: m.HeroGraph })),
  { ssr: false },
);

const DynamicInteractiveGraph = dynamic(
  () =>
    import("./interactive-graph").then((m) => ({
      default: m.InteractiveGraph,
    })),
  { ssr: false },
);

export { DynamicHeroGraph as HeroGraph, DynamicInteractiveGraph as InteractiveGraph };
