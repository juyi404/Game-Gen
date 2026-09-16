export function providerFromModel(model) {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "";
}

export function validIdentifier(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value);
}

export function clampInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

export function timeoutMinutesToMs(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return Math.round(minutes * 60_000);
}

export function percentage(value, total) { return total ? Math.round((value / total) * 100) : 0; }

export function formatShortId(id) { return id ? id.slice(0, 8) : "—"; }

export function formatTime(timestamp) { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(timestamp); }

export function formatDate(timestamp) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(timestamp); }

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}时 ${minutes}分` : minutes ? `${minutes}分 ${rest}秒` : `${rest}秒`;
}

export function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
