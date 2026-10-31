// Runs before first paint, ahead of the deferred app bundle: without it a light-theme
// user sees a dark page on every launch. A file because the Tauri CSP forbids inline scripts.
try {
  if (JSON.parse(localStorage.getItem('utai.settings'))?.theme === 'light') {
    document.documentElement.dataset.theme = 'light';
  }
} catch {
  // unavailable or corrupt storage: stay on the default theme
}
