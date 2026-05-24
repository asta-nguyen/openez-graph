import type { BrainConfig } from "@openez-graph/config";

const config: BrainConfig = {
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
        // Documentation
        "**/*.md",
        // Config files - critical for understanding system
        "package.json",
        "tsconfig*.json",
        "next.config.*",
        "drizzle.config.*",
        "eslint.config.*",
        "vite.config.*",
        "tailwind.config.*",
        "turbo.json",
        "vitest.config.*",
        // Optional but valuable
        "prisma/schema.prisma"
      ],
      exclude: [
        // Generated output - DO NOT INDEX
        "node_modules/**",
        "**/node_modules/**",
        ".next/**",
        "**/.next/**",
        "dist/**",
        "**/dist/**",
        "build/**",
        "**/build/**",
        "coverage/**",
        "**/coverage/**",
        // Package artifacts
        ".turbo/**",
        "**/.turbo/**",
        // Git
        ".git/**",
        // IDE and editor files
        ".vscode/**",
        ".idea/**",
        // OS files
        ".DS_Store",
        "**/.DS_Store",
        // Lock files
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        // Generated/nested node_modules
        "**/node_modules/**",
        // Cache directories
        ".cache/**",
        "__pycache__/**",
        "*.pyc"
      ]
    }
  ],
  chunking: {
    targetTokens: 700,
    overlapTokens: 100
  },
  retrieval: {
    vectorLimit: 20,
    textLimit: 20,
    graphHops: 1,
    maxGraphNeighbors: 20,
    finalLimit: 12,
    maxContextTokens: 8000
  }
};

export default config;
