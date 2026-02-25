"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type Theme = "zinc" | "stone" | "slate" | "sage" | "dusk";
export type Mode = "light" | "dark";

interface ThemeContextValue {
  theme: Theme;
  mode: Mode;
  setTheme: (t: Theme) => void;
  setMode: (m: Mode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "zinc",
  mode: "dark",
  setTheme: () => {},
  setMode: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("zinc");
  const [mode, setModeState] = useState<Mode>("dark");
  const [mounted, setMounted] = useState(false);

  // Read from localStorage on mount
  useEffect(() => {
    const validThemes = new Set<Theme>(["zinc", "stone", "slate", "sage", "dusk"]);
    const validModes = new Set<Mode>(["light", "dark"]);
    const stored = localStorage.getItem("tc-theme");
    const storedMode = localStorage.getItem("tc-mode");
    if (stored && validThemes.has(stored as Theme)) setThemeState(stored as Theme);
    if (storedMode && validModes.has(storedMode as Mode)) setModeState(storedMode as Mode);
    setMounted(true);
  }, []);

  // Apply to <html>
  useEffect(() => {
    if (!mounted) return;
    const html = document.documentElement;
    html.setAttribute("data-theme", theme);
    html.classList.toggle("dark", mode === "dark");
  }, [theme, mode, mounted]);

  const setTheme = (t: Theme) => {
    setThemeState(t);
    localStorage.setItem("tc-theme", t);
  };

  const setMode = (m: Mode) => {
    setModeState(m);
    localStorage.setItem("tc-mode", m);
  };

  return (
    <ThemeContext.Provider value={{ theme, mode, setTheme, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}
