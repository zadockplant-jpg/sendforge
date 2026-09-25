export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function money(cents, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format((cents || 0) / 100);
}

// Calendar dates (YYYY-MM-DD) are shown as written; timestamps are shown in Michigan time.
export function formatDate(value) {
  if (!value) return "";
  const calendarDate = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const date = new Date(calendarDate ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: calendarDate ? "UTC" : "America/Detroit"
  });
}
