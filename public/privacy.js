// Privacy page language toggle.
// Pure DOM toggle — no analytics, no network call, no cookies.
// Persistence is best-effort via localStorage; falls back to browser language.
(function () {
  var fr = document.getElementById('contentFr');
  var en = document.getElementById('contentEn');
  var btns = document.querySelectorAll('.lang-bar button');

  function setLang(l) {
    var isFr = l === 'fr';
    if (fr) fr.hidden = !isFr;
    if (en) en.hidden = isFr;
    document.documentElement.lang = l;
    document.title = isFr
      ? 'Politique de confidentialité · Coach Adaptatif'
      : 'Privacy Policy · Coach Adaptatif';
    btns.forEach(function (b) {
      b.setAttribute('aria-pressed', b.dataset.lang === l ? 'true' : 'false');
    });
    var backSpan = document.querySelector('#backLink span');
    if (backSpan) backSpan.textContent = isFr ? "Retour à l'application" : 'Back to the app';
    try { localStorage.setItem('coachPrivacyLang', l); } catch (e) { /* noop */ }
  }

  btns.forEach(function (b) {
    b.addEventListener('click', function () { setLang(b.dataset.lang); });
  });

  var initial = 'fr';
  try {
    var saved = localStorage.getItem('coachPrivacyLang');
    if (saved === 'en' || saved === 'fr') {
      initial = saved;
    } else if ((navigator.language || '').toLowerCase().indexOf('fr') !== 0) {
      initial = 'en';
    }
  } catch (e) { /* noop */ }
  setLang(initial);
})();
