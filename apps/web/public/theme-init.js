// Applies the cached theme before first paint (TDD §6.6, NFR-UX-001). External file because the
// CSP allows no inline script. The signed-in user's saved preference replaces this after load.
try {
  var t = localStorage.getItem('cw-theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
} catch {
  /* storage unavailable: the system preference applies */
}
