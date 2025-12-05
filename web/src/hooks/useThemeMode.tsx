"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "linelight:theme";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeModeContext = createContext<ThemeContextValue | null>(null);

const readInitialMode = (): ThemeMode => {
  if (typeof window === "undefined") {
    return "light";
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return "light";
};

const applyThemeToDocument = (mode: ThemeMode) => {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = mode;
};

export const ThemeProvider = ({ children }: { children: React.ReactNode }) => {
  const [mode, setMode] = useState<ThemeMode>(() => {
    const initial = readInitialMode();
    applyThemeToDocument(initial);
    return initial;
  });

  useEffect(() => {
    applyThemeToDocument(mode);
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(() => ({ mode, setMode }), [mode]);

  return <ThemeModeContext.Provider value={value}>{children}</ThemeModeContext.Provider>;
};

export const useThemeMode = () => {
  const ctx = useContext(ThemeModeContext);
  
  const toggleTheme = useCallback(() => {
    if (ctx) {
      ctx.setMode(ctx.mode === "light" ? "dark" : "light");
    }
  }, [ctx]);
  
  if (!ctx) {
    return {
      mode: "light" as ThemeMode,
      setMode: () => {},
      toggleTheme,
    };
  }
  
  return { ...ctx, toggleTheme };
};
