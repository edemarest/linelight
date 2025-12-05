export const humanizeDirection = (direction?: string) => {
  if (!direction) return "Direction";
  const trimmed = direction.trim();
  if (!trimmed) return "Direction";
  const normalized = trimmed.toLowerCase();
  if (normalized === "inbound" || normalized === "outbound") {
    return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
  }
  if (normalized.startsWith("to ")) {
    return `To ${trimmed.slice(3).trim()}`;
  }
  if (normalized.startsWith("toward")) {
    return `Towards ${trimmed.slice(6).trim()}`;
  }
  return trimmed;
};
