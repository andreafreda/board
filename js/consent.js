// ════════════════════════════════════════════════════════════════════
//   consent.js — first-visit privacy / cookie banner
// ════════════════════════════════════════════════════════════════════
// We don't use tracking cookies, but the app does:
//   - Authenticate users via Google OAuth (sends data to Google)
//   - Load Google avatars at every visit (also sends a request to Google)
//   - Persist session tokens + preferences in localStorage
// To be GDPR-clean we ask the user to acknowledge this once.

const CONSENT_KEY = 'board-lite-consent';

function hasAccepted() {
  try { return localStorage.getItem(CONSENT_KEY) === 'accepted'; } catch { return false; }
}

function persistAccept() {
  try { localStorage.setItem(CONSENT_KEY, 'accepted'); } catch {}
}

function buildBanner() {
  const el = document.createElement('div');
  el.className = 'consent-banner on';
  el.id = 'consentBanner';
  el.innerHTML = `
    <div class="consent-text">
      Questa app usa <strong>Google Sign-In</strong> e il
      <strong>localStorage</strong> del browser per ricordare il tuo lavoro.
      Niente cookie di tracciamento, niente analytics. Continuando accetti
      la <a href="./privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.
    </div>
    <button class="consent-accept" type="button">Ho capito</button>
  `;
  el.querySelector('.consent-accept').addEventListener('click', () => {
    persistAccept();
    el.classList.remove('on');
    setTimeout(() => el.remove(), 250);
  });
  return el;
}

export function consentInit() {
  if (hasAccepted()) return;
  // Wait for DOM ready (modules are deferred so this should be safe)
  document.body.appendChild(buildBanner());
}
