export const normalizeHexColor = (
  value?: string | null,
  options?: { uppercase?: boolean },
): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return options?.uppercase ? normalized.toUpperCase() : normalized;
};
