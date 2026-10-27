"use client";

import dynamic from "next/dynamic";

const DynamicHeroGraph = dynamic(
  () => import("./hero-graph").then((m) => ({ default: m.HeroGraph })),
  { ssr: false },
);

export { DynamicHeroGraph as HeroGraph };
