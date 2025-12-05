"use client";

import { useEffect, useState } from "react";

const BREAKPOINTS = {
  mobile: 640,
  tablet: 1024,
};

const getViewportWidth = () => {
  if (typeof window === "undefined") {
    return BREAKPOINTS.tablet;
  }
  return window.innerWidth;
};

export type BreakpointInfo = {
  width: number;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
};

export const useBreakpoint = (): BreakpointInfo => {
  const [width, setWidth] = useState<number>(getViewportWidth);

  useEffect(() => {
    const handleResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", handleResize, { passive: true });
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const isMobile = width < BREAKPOINTS.mobile;
  const isTablet = width >= BREAKPOINTS.mobile && width < BREAKPOINTS.tablet;
  const isDesktop = width >= BREAKPOINTS.tablet;

  return { width, isMobile, isTablet, isDesktop };
};

export const breakpointClass = (info: BreakpointInfo) =>
  info.isDesktop ? "desktop" : info.isTablet ? "tablet" : "mobile";
