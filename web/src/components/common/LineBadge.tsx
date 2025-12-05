import { useMemo } from "react";
import { getLineToken } from "@/lib/designTokens";
import { useThemeMode } from "@/hooks/useThemeMode";

export const LineBadge = ({
  lineId,
  label,
  active = false,
}: {
  lineId: string;
  label?: string | null;
  active?: boolean;
}) => {
  const { mode: themeMode } = useThemeMode();
  const token = useMemo(() => getLineToken(lineId, themeMode), [lineId, themeMode]);
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-semibold uppercase tracking-wide"
      style={{
        background: active ? token.tint : "var(--surface)",
        color: active ? token.textOnTint : token.color,
        border: `1px solid ${token.border}`,
      }}
    >
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{ background: token.color, border: `1px solid ${token.border}` }}
        aria-hidden="true"
      />
      <span>{label ?? token.label ?? lineId}</span>
    </span>
  );
};
