import { MoonIcon, BrightnessDownIcon } from "@openez-graph/ui";
import { useTheme } from "../lib/theme";
import { Button } from "@openez-graph/ui";

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme((resolvedTheme ?? theme) === "light" ? "dark" : "light")}
      className="h-8 w-8"
    >
      <BrightnessDownIcon size={16} className="rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <MoonIcon size={16} className="absolute rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
