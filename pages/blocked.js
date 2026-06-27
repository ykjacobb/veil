var params = new URLSearchParams(location.search);
var reason = params.get("reason") || "filter";
var kw = params.get("kw");
var u = params.get("u");

var labels = {
  domain: "Matched the blocked-domain list.",
  keyword: "URL matched a blocked keyword" + (kw ? ': "' + kw + '"' : "") + ".",
  spa: "In-page navigation matched a blocked term.",
  content: "Page URL matched a blocked term."
};

var el = document.getElementById("reason");
el.textContent = labels[reason] || "Filtered by VEIL.";
if (u) {
  var line = document.createElement("div");
  line.style.marginTop = "8px";
  line.style.opacity = "0.7";
  line.textContent = u;
  el.appendChild(line);
}
