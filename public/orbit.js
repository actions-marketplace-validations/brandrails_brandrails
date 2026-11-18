// Touch support for the hero orbit: a tap grows and tilts a tag and pauses the orbit; a tap elsewhere releases it.
(function () {
  var orbit = document.querySelector(".orbit");
  if (!orbit) return;
  function clear() {
    orbit.classList.remove("is-paused");
    orbit.querySelectorAll(".tag.is-active").forEach(function (t) { t.classList.remove("is-active"); });
  }
  document.addEventListener("pointerdown", function (e) {
    if (e.pointerType === "mouse") return;
    var tag = e.target.closest && e.target.closest(".orbit .tag");
    var was = tag && tag.classList.contains("is-active");
    clear();
    if (tag && !was) { tag.classList.add("is-active"); orbit.classList.add("is-paused"); }
  });
})();
