// Picks the palette before first paint, so a light theme does not open on a
// flash of dark. A plain blocking file because the CSP allows no inline script.
// Mirrors loadThemePrefs() + resolveTheme() in src/lib/theme.ts: keep in step.
(function () {
  var theme = 'system';
  try {
    var saved = JSON.parse(localStorage.getItem('wacli_theme') || 'null');
    if (saved && typeof saved.theme === 'string') theme = saved.theme;
  } catch (e) {
    // Unreadable storage: fall through to the system setting.
  }
  if (theme === 'system') {
    var light = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    theme = light ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
