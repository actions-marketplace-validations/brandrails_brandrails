// Google Analytics behind a consent banner (EU). Nothing loads and no cookie is set until the
// visitor accepts. The choice is kept in localStorage; "Cookie settings" in the footer reopens it.
(function () {
  var GA_ID = "G-BVLCKB3ZR7";
  var KEY = "brandrails-consent";
  var loaded = false;

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag("consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function loadAnalytics() {
    if (loaded) return;
    loaded = true;
    gtag("consent", "update", { analytics_storage: "granted" });
    gtag("js", new Date());
    // 13-month cookies, no ads features.
    gtag("config", GA_ID, { cookie_expires: 33696000, allow_google_signals: false, allow_ad_personalization_signals: false });
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_ID;
    document.head.appendChild(s);
  }

  function clearCookies() {
    document.cookie.split(";").forEach(function (c) {
      var name = c.split("=")[0].trim();
      if (name === "_ga" || name.indexOf("_ga_") === 0) {
        ["", "; domain=." + location.hostname.split(".").slice(-2).join("."), "; domain=" + location.hostname].forEach(function (d) {
          document.cookie = name + "=; Max-Age=0; path=/" + d;
        });
      }
    });
  }

  function banner() {
    var old = document.getElementById("consent");
    if (old) old.remove();
    var el = document.createElement("section");
    el.id = "consent";
    el.className = "consent card";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Cookie consent");
    el.innerHTML =
      '<p><strong>Can we count your visit?</strong> We use Google Analytics cookies to see which pages people read. Nothing is tracked unless you accept. <a href="/privacy#analytics">Details</a></p>' +
      '<div class="row"><button type="button" class="btn btn--sand" data-choice="granted">Accept</button><button type="button" class="btn" data-choice="denied">Decline</button></div>';
    el.addEventListener("click", function (e) {
      var choice = e.target.getAttribute && e.target.getAttribute("data-choice");
      if (!choice) return;
      write(choice);
      el.remove();
      if (choice === "granted") loadAnalytics();
      else if (loaded) {
        gtag("consent", "update", { analytics_storage: "denied" });
        clearCookies();
      } else clearCookies();
    });
    document.body.appendChild(el);
  }

  window.brandrailsConsent = banner;
  var choice = read();
  if (choice === "granted") loadAnalytics();
  document.addEventListener("DOMContentLoaded", function () {
    if (!choice) banner();
    document.querySelectorAll("[data-consent-settings]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); banner(); });
    });
  });
})();
