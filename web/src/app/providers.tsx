"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode, Suspense, useState } from "react";
import { AppStateProvider } from "@/state/appState";
import { ThemeProvider } from "@/hooks/useThemeMode";
import { AppNavbar } from "@/components/nav/AppNavbar";
import { AppFooter } from "@/components/nav/AppFooter";

export const Providers = ({ children }: { children: ReactNode }) => {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <AppStateProvider>
        <ThemeProvider>
          <Suspense fallback={null}>
            <AppNavbar />
          </Suspense>
          {children}
          <AppFooter />
        </ThemeProvider>
      </AppStateProvider>
    </QueryClientProvider>
  );
};
