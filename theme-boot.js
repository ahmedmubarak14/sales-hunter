/* Set the theme before first paint to avoid a flash of the wrong one.
   Default light; dark only if the user previously chose it.

   This lives in its own file rather than inline in index.html so the
   Content-Security-Policy can forbid inline scripts outright — an inline
   <script> here would force script-src 'unsafe-inline', which is most of
   what the policy exists to prevent. It must stay a plain synchronous
   <script> in <head> (no defer/async) so it runs before the first paint. */
try {
  var _t = localStorage.getItem('sh.theme');
  document.documentElement.setAttribute('data-theme', _t ? JSON.parse(_t) : 'light');
} catch (e) {
  document.documentElement.setAttribute('data-theme', 'light');
}
