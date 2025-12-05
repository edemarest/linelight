const HEX_REGEX = /^#?([a-f\d]{6})$/i;

const withAlpha = (hex: string, alpha: number): string => {
  const match = HEX_REGEX.exec(hex);
  const normalized = match ? match[1] : "94A3B8";
  const bigint = Number.parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

type ColorScheme = "light" | "dark";

const getActiveScheme = (): ColorScheme => {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.dataset.theme;
    if (attr === "dark") {
      return "dark";
    }
  }
  return "light";
};

export interface LineToken {
  id: string;
  label: string;
  color: string;
  tint: string;
  border: string;
  textOnTint: string;
  textOnSolid: string;
}

const LINE_BASE: Array<[string, string, string]> = [
  ["Red", "Red Line", "#E0362D"],
  ["Orange", "Orange Line", "#EC8B2D"],
  ["Blue", "Blue Line", "#2D7FE0"],
  ["Green-B", "Green Line B", "#4FB870"],
  ["Green-C", "Green Line C", "#4FB870"],
  ["Green-D", "Green Line D", "#4FB870"],
  ["Green-E", "Green Line E", "#4FB870"],
  ["Mattapan", "Mattapan", "#D1367A"],
  ["Bus", "Bus", "#F4C542"],
];

const BASE_TOKEN_MAP = new Map(
  LINE_BASE.map(([id, label, color]) => [
    id,
    {
      id,
      label,
      color,
    },
  ]),
);

const FALLBACK_COLOR = {
  id: "default",
  label: "Line",
  color: "#94A3B8",
};

const resolveLineKey = (routeId?: string | null): string | null => {
  if (!routeId) return null;
  if (BASE_TOKEN_MAP.has(routeId)) return routeId;
  if (routeId.startsWith("Green-")) return "Green-B";
  if (/^\d+$/.test(routeId)) return "Bus";
  if (routeId.toLowerCase().includes("bus")) return "Bus";
  return null;
};

const buildLineVariant = (color: string, scheme: ColorScheme) => {
  const tintAlpha = scheme === "light" ? 0.12 : 0.26;
  const borderAlpha = scheme === "light" ? 0.28 : 0.55;
  return {
    tint: withAlpha(color, tintAlpha),
    border: withAlpha(color, borderAlpha),
    textOnTint: scheme === "light" ? color : "#E2E8F0",
    textOnSolid: "#04121f",
  };
};

export const getLineToken = (routeId?: string | null, scheme?: ColorScheme): LineToken => {
  const key = resolveLineKey(routeId);
  const base = key ? BASE_TOKEN_MAP.get(key) ?? FALLBACK_COLOR : FALLBACK_COLOR;
  const activeScheme = scheme ?? getActiveScheme();
  const variant = buildLineVariant(base.color, activeScheme);
  return {
    id: base.id,
    label: base.label,
    color: base.color,
    tint: variant.tint,
    border: variant.border,
    textOnTint: variant.textOnTint,
    textOnSolid: variant.textOnSolid,
  };
};

export interface DirectionToken {
  id: "inbound" | "outbound" | "unknown";
  label: string;
  icon: string;
  bg: string;
  border: string;
  text: string;
  textMuted: string;
}

const DIRECTION_BASE = {
  inbound: { icon: "↘", color: "#2563EB" },
  outbound: { icon: "↗", color: "#EA580C" },
  unknown: { icon: "•", color: "#94A3B8" },
} as const;

const buildDirectionVariant = (color: string, scheme: ColorScheme) => {
  const tintAlpha = scheme === "light" ? 0.12 : 0.25;
  const borderAlpha = scheme === "light" ? 0.25 : 0.45;
  return {
    bg: withAlpha(color, tintAlpha),
    border: withAlpha(color, borderAlpha),
    text: scheme === "light" ? color : "#E2E8F0",
    textMuted: scheme === "light" ? color : "#CBD5F5",
  };
};

export const getDirectionToken = (
  directionId?: 0 | 1 | null,
  label?: string | null,
  scheme?: ColorScheme,
): DirectionToken => {
  const activeScheme = scheme ?? getActiveScheme();
  if (directionId === 0) {
    const variant = buildDirectionVariant(DIRECTION_BASE.inbound.color, activeScheme);
    return { id: "inbound", label: "Inbound", icon: DIRECTION_BASE.inbound.icon, ...variant };
  }
  if (directionId === 1) {
    const variant = buildDirectionVariant(DIRECTION_BASE.outbound.color, activeScheme);
    return { id: "outbound", label: "Outbound", icon: DIRECTION_BASE.outbound.icon, ...variant };
  }
  const variant = buildDirectionVariant(DIRECTION_BASE.unknown.color, activeScheme);
  return {
    id: "unknown",
    label: label ?? "—",
    icon: DIRECTION_BASE.unknown.icon,
    ...variant,
  };
};
