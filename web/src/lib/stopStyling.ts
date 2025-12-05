import { getLineToken } from "./designTokens";
import type { ThemeMode } from "@/hooks/useThemeMode";
import { LANDMARK_BY_ID, LANDMARK_BY_SLUG } from "./landmarkManifest";

export interface StopHue {
  background: string;
  borderColor: string;
  accentColor: string;
}

const MULTI_LINE_COLOR = "#7C7E7F";
const DEFAULT_BORDER_LIGHT = "rgba(0,0,0,0.08)";
const DEFAULT_BORDER_DARK = "rgba(255,255,255,0.18)";

const hexToRgba = (hex: string, alpha: number) => {
  const normalized = hex.replace("#", "");
  const bigint = Number.parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const gradientForColor = (color: string, scheme: ThemeMode): StopHue => {
  const startAlpha = scheme === "dark" ? 0.28 : 0.12;
  const endAlpha = scheme === "dark" ? 0.55 : 0.28;
  const borderAlpha = scheme === "dark" ? 0.7 : 0.45;
  return {
    background: `linear-gradient(135deg, ${hexToRgba(color, startAlpha)} 0%, ${hexToRgba(color, endAlpha)} 100%)`,
    borderColor: hexToRgba(color, borderAlpha),
    accentColor: color,
  };
};

export const getStopHue = (routeIds: string[], scheme: ThemeMode): StopHue => {
  const uniqueIds = Array.from(new Set(routeIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return {
      background: "var(--card)",
      borderColor: scheme === "dark" ? DEFAULT_BORDER_DARK : DEFAULT_BORDER_LIGHT,
      accentColor: scheme === "dark" ? "var(--border-strong)" : "var(--border)",
    };
  }
  if (uniqueIds.length === 1) {
    const token = getLineToken(uniqueIds[0], scheme);
    return gradientForColor(token.color, scheme);
  }
  return gradientForColor(MULTI_LINE_COLOR, scheme);
};

const normalizeKey = (value?: string | null) => value?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";

export const getLandmarkImage = (options: { stopName?: string | null; stopId?: string | null }) => {
  const normalizedId = options.stopId ? options.stopId.toLowerCase() : "";
  const landmarkLookup = LANDMARK_BY_ID as Record<string, string>;
  if (normalizedId && landmarkLookup[normalizedId]) {
    return landmarkLookup[normalizedId];
  }
  const normalizedName = normalizeKey(options.stopName);
  const slugLookup = LANDMARK_BY_SLUG as Record<string, string>;
  if (normalizedName && slugLookup[normalizedName]) {
    return slugLookup[normalizedName];
  }
  return null;
};
