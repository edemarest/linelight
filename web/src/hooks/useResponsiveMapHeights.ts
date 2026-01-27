"use client";

import { BreakpointInfo } from "./useBreakpoint";

const MOBILE_MAP_HEIGHT = "clamp(320px, 50vh, 520px)";

export interface UseResponsiveMapHeightsProps {
  preferStackedLayout: boolean;
  breakpointInfo: BreakpointInfo;
}

export const useResponsiveMapHeights = ({ preferStackedLayout, breakpointInfo }: UseResponsiveMapHeightsProps) => {
  const { isMobile } = breakpointInfo;

  // Return an explicit height and a maxHeight to avoid producing complex/min() expressions
  // which can be reformatted by browsers and sometimes produce unexpected results.
  const mapPanelHeight = preferStackedLayout
    ? isMobile
      ? MOBILE_MAP_HEIGHT
      : "520px"
    : "auto";
  const mapPanelMaxHeight = preferStackedLayout ? undefined : "900px";

  const mobileSheetHeight = preferStackedLayout && isMobile ? `calc(100vh - ${MOBILE_MAP_HEIGHT} - 24px)` : "88vh";

  return {
    mapPanelHeight,
    mapPanelMaxHeight,
    mobileSheetHeight,
  };
};
