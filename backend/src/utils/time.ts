export const parseTimestamp = (value?: string | null): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const computeCountdownSeconds = (timestamp?: string | null): number | null => {
  const parsed = parseTimestamp(timestamp);
  if (parsed == null) return null;
  return Math.max(0, Math.round((parsed - Date.now()) / 1000));
};

export const computeEtaMinutes = (timestamp?: string | null): number | null => {
  const parsed = parseTimestamp(timestamp);
  if (parsed == null) return null;
  return Math.max(0, Math.round((parsed - Date.now()) / 60000));
};
