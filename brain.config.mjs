const config = {
  workspaces: [
    {
      id: "openez",
      name: "openez",
      root: ".",
      include: [
        "apps/**/*.{ts,tsx,js,jsx}",
        "packages/**/*.{ts,tsx,js,jsx}",
        "src/**/*.{ts,tsx,js,jsx}",
        "app/**/*.{ts,tsx,js,jsx}",
        "pages/**/*.{ts,tsx,js,jsx}",
        "lib/**/*.{ts,tsx,js,jsx}",
        "tests/**/*.{ts,tsx,js,jsx}",
        "**/*.md",
      ],
      exclude: [
        "node_modules/**",
        "**/node_modules/**",
        ".next/**",
        "dist/**",
        "build/**",
        ".git/**",
        "coverage/**",
        "**/.turbo/**",
      ],
    },
    {
      id: "vibepro",
      name: "vibepro",
      root: "/Users/nus/projects/Asta/vibepro",
      include: [
        "apps/**/*.{ts,tsx,js,jsx}",
        "packages/**/*.{ts,tsx,js,jsx}",
        "src/**/*.{ts,tsx,js,jsx}",
        "app/**/*.{ts,tsx,js,jsx}",
        "pages/**/*.{ts,tsx,js,jsx}",
        "lib/**/*.{ts,tsx,js,jsx}",
        "tests/**/*.{ts,tsx,js,jsx}",
        "**/*.md",
      ],
      exclude: [
        "node_modules/**",
        "**/node_modules/**",
        ".next/**",
        "dist/**",
        "build/**",
        ".git/**",
        "coverage/**",
        "**/.turbo/**",
      ],
    },
  ],
  chunking: {
    targetTokens: 700,
    overlapTokens: 100,
  },
  retrieval: {
    vectorLimit: 20,
    textLimit: 20,
    graphHops: 1,
    maxGraphNeighbors: 20,
    finalLimit: 12,
    maxContextTokens: 8000,
  },
};

export default config;
