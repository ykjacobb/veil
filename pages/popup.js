var DEFAULTS = {
  urlFilteringEnabled: true,
  visualFilteringEnabled: false,
  paid: false,
  nsfwThreshold: 0.5
};

var urlEl = document.getElementById("urlFiltering");
var visualEl = document.getElementById("visualFiltering");
var upsellEl = document.getElementById("upsell");
var tierEl = document.getElementById("tier");
var unlockBtn = document.getElementById("unlock");
var sensRow = document.getElementById("sensRow");
var sensEl = document.getElementById("sensitivity");
var sensLabel = document.getElementById("sensLabel");

// Sensitivity slider 0..100 maps inversely to threshold 0.8 (lenient) .. 0.2
// (aggressive). Higher slider = blocks more = lower threshold.
function sliderToThreshold(v) {
  return 0.8 - (v / 100) * 0.6;
}
function thresholdToSlider(t) {
  return Math.round(((0.8 - t) / 0.6) * 100);
}
function sensName(v) {
  if (v >= 75) return "Aggressive";
  if (v >= 40) return "Balanced";
  return "Lenient";
}

function render(s) {
  urlEl.checked = s.urlFilteringEnabled;
  var visualOn = s.visualFilteringEnabled && s.paid;
  visualEl.checked = visualOn;
  visualEl.disabled = !s.paid;
  upsellEl.classList.toggle("show", !s.paid);
  tierEl.textContent = s.paid ? "Paid" : "Free";
  tierEl.classList.toggle("paid", s.paid);

  sensRow.classList.toggle("show", visualOn);
  var v = thresholdToSlider(s.nsfwThreshold);
  sensEl.value = v;
  sensLabel.textContent = sensName(v);
}

chrome.storage.sync.get(DEFAULTS).then(render);

urlEl.addEventListener("change", function () {
  chrome.storage.sync.set({ urlFilteringEnabled: urlEl.checked });
});

visualEl.addEventListener("change", function () {
  chrome.storage.sync.set({ visualFilteringEnabled: visualEl.checked });
  chrome.storage.sync.get(DEFAULTS).then(render);
});

sensEl.addEventListener("input", function () {
  var v = Number(sensEl.value);
  sensLabel.textContent = sensName(v);
  chrome.storage.sync.set({ nsfwThreshold: sliderToThreshold(v) });
});

unlockBtn.addEventListener("click", function () {
  // Dev shortcut. In production this flips after a verified subscription.
  chrome.storage.sync.set({ paid: true, visualFilteringEnabled: true }).then(function () {
    chrome.storage.sync.get(DEFAULTS).then(render);
  });
});
