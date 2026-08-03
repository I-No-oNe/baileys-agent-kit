export type LocalRegionSignals = {
  locale?: string;
  timeZone?: string;
};

export function detectLocalCountryCode(signals: LocalRegionSignals = {}): string | undefined {
  const timeZone = signals.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timeZone === "Asia/Jerusalem") return "IL";

  const locale = signals.locale ?? Intl.DateTimeFormat().resolvedOptions().locale;
  try {
    const region = new Intl.Locale(locale.replace("_", "-")).region;
    if (region) return region.toUpperCase();
  } catch {
    // Fall back to the timezone when the OS exposes a non-standard locale.
  }

  return undefined;
}

export function prefersPairingCode(signals?: LocalRegionSignals): boolean {
  return detectLocalCountryCode(signals) === "IL";
}
