"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/context/ThemeContext";

export default function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-lg bg-theme-card border border-theme-border text-theme-heading hover:text-stellar-blue transition-colors duration-200 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-stellar-blue/50"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? (
        <Sun size={20} className="animate-in fade-in zoom-in duration-300" />
      ) : (
        <Moon size={20} className="animate-in fade-in zoom-in duration-300" />
      )}
    </button>
  );
}
