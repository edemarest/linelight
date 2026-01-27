export const directionIdToLabel = (directionId: number | null | undefined): string => {
  if (directionId === 0) return "Inbound";
  if (directionId === 1) return "Outbound";
  return "Unknown";
};

export const isGenericDirectionLabel = (value?: string | null): boolean => {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === "inbound" || normalized === "outbound" || normalized === "unknown";
};
