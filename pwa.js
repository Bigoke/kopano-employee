/* Kopano Employee web app (1.52): the version, and the service worker that keeps the app working offline. */
window.KP_WEB_VERSION = '1.56.0';
if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* the app works without it */ });
  });
}
