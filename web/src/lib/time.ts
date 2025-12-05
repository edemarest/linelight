const formatDurationLabel = (etaMinutes: number | null | undefined): string | null => {
  if (etaMinutes === null || typeof etaMinutes === "undefined") {
    return null;
  }
  const roundedMinutes = Math.round(etaMinutes);
  if (roundedMinutes <= 0) {
    return null;
  }
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (parts.length === 0) {
    parts.push("1m");
  }
  return parts.join(" ");
};

export const formatEta = (etaMinutes: number | null | undefined): string => {
  if (etaMinutes === null || typeof etaMinutes === "undefined") {
    return "—";
  }
  if (etaMinutes <= 0) {
    return "Due";
  }
  return formatDurationLabel(etaMinutes) ?? "Due";
};

export const formatEtaChip = (value: number | null): string => {
  if (value == null) return "—";
  if (value <= 0) return "Now";
  return formatDurationLabel(value) ?? "Now";
};
