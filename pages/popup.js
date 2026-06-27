var DEFAULTS = {
  urlFilteringEnabled: true,
  visualFilteringEnabled: false,
  paid: false
};

var urlEl = document.getElementById("urlFiltering");
var visualEl = document.getElementById("visualFiltering");
var upsellEl = document.getElementById("upsell");
var tierEl = document.getElementById("tier");
var unlockBtn = document.getElementById("unlock");

function render(s) {
  urlEl.checked = s.urlFilteringEnabled;
  visualEl.checked = s.visualFilteringEnabled && s.paid;
  visualEl.disabled = !s.paid;
  upsellEl.classList.toggle("show", !s.paid);
  tierEl.textContent = s.paid ? "Paid" : "Free";
  tierEl.classList.toggle("paid", s.paid);
}

chrome.storage.sync.get(DEFAULTS).then(render);

urlEl.addEventListener("change", function () {
  chrome.storage.sync.set({ urlFilteringEnabled: urlEl.checked });
});

visualEl.addEventListener("change", function () {
  chrome.storage.sync.set({ visualFilteringEnabled: visualEl.checked });
});

unlockBtn.addEventListener("click", function () {
  // Dev shortcut. In production this flips after a verified subscription.
  chrome.storage.sync.set({ paid: true, visualFilteringEnabled: true }).then(function () {
    chrome.storage.sync.get(DEFAULTS).then(render);
  });
});
