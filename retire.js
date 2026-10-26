/* Ask the browser to re-check the service worker already installed for this site.
   Opening the page does not always do that: Chrome skips the check when it did one
   recently, and GitHub Pages caches sw.js for several minutes. Re-registering with
   updateViaCache "none" forces a network check of the same worker. The retirement
   worker then clears the app caches and unregisters. With nothing installed, this
   script does nothing, so it does not keep reinstalling itself. */
(function () {
  if (!('serviceWorker' in navigator)) return;
  var KEY = 'orp-retire-once';
  var SCOPE = '/outreach-route-planner/';
  var SCRIPT = '/outreach-route-planner/sw.js';
  try { if (sessionStorage.getItem(KEY) === '1') return; } catch (e) {}
  navigator.serviceWorker.getRegistration(SCOPE).then(function (reg) {
    if (!reg) return;
    try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
    return navigator.serviceWorker.register(SCRIPT, { scope: SCOPE, updateViaCache: 'none' });
  }).catch(function () {
    try { sessionStorage.removeItem(KEY); } catch (e) {}
  });
})();
