import type { ComponentType } from "react";
import type { DirectionToken } from "@/lib/designTokens";
import { FiArrowDownLeft, FiArrowUpRight, FiArrowRight } from "react-icons/fi";

const ICON_LOOKUP: Record<DirectionToken["id"], ComponentType<{ size?: number }>> = {
  inbound: FiArrowDownLeft,
  outbound: FiArrowUpRight,
  unknown: FiArrowRight,
};

export const DirectionArrowIcon = ({
  token,
  size = "md",
}: {
  token: DirectionToken;
  size?: "sm" | "md";
}) => {
  const IconComponent = ICON_LOOKUP[token.id] ?? ICON_LOOKUP.unknown;
  const dimension = size === "sm" ? 20 : 26;
  return (
    <span
      className={`direction-arrow ${size === "sm" ? "direction-arrow-sm" : "direction-arrow-md"}`}
      style={{
        borderColor: token.border,
        color: token.text,
      }}
      aria-hidden="true"
    >
      <IconComponent size={dimension * 0.55} />
    </span>
  );
};
