"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, useState } from "react";
import { AppStateProvider } from "@/state/appState";
import { ThemeProvider } from "@/hooks/useThemeMode";
import { AppNavbar } from "@/components/nav/AppNavbar";

export const Providers = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AppStateProvider>
        <ThemeProvider>
          <AppNavbar />
          {children}
        </ThemeProvider>
      </AppStateProvider>
    </QueryClientProvider>
  );
};

