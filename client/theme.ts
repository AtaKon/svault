export type Theme = "light" | "dark";

export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem("sv-theme", theme);
  } catch {
    /* ignore */
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#12100e" : "#f6f4ef");
}

export function toggleTheme(): Theme {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
