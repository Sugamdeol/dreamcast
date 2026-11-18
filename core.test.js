const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("./core.js");

const GOOD = `<!doctype html>
<html><head><title>Frog Fly Feast</title></head>
<body><canvas id="c" width="400" height="300"></canvas>
<script>
var score = 0;
document.addEventListener("keydown", function (e) { score += 1; });
function loop() { requestAnimationFrame(loop); }
loop();
</script></body></html>`;

test("a fenced reply yields the html inside the fence", () => {
  const out = D.extractHtml("Here you go:\n```html\n" + GOOD + "\n```\nEnjoy!");
  assert.equal(out.ok, true);
  assert.ok(out.html.startsWith("<!doctype html>"));
  assert.ok(out.html.endsWith("</html>"));
});

test("a reply with a sentence before the doctype is trimmed", () => {
  const out = D.extractHtml("Sure! Here is your game.\n" + GOOD);
  assert.equal(out.ok, true);
  assert.ok(out.html.startsWith("<!doctype html>"));
});

test("a bare fragment is wrapped into a document", () => {
  const out = D.extractHtml("<canvas width=200 height=200></canvas><script>requestAnimationFrame(function l(){requestAnimationFrame(l)})</script>");
  assert.equal(out.ok, true);
  assert.ok(out.html.includes("<!doctype html>"));
  assert.ok(out.html.includes("</html>"));
});

test("a truncated document is closed rather than left broken", () => {
  const cut = GOOD.slice(0, GOOD.indexOf("</body>"));
  const out = D.extractHtml(cut);
  assert.equal(out.ok, true);
  assert.ok(out.html.endsWith("</html>"));
});

test("a reply with no html and no script is refused", () => {
  const out = D.extractHtml("I cannot help with that.");
  assert.equal(out.ok, false);
  assert.ok(out.error.includes("no html"));
});

test("a document with no script is refused", () => {
  const out = D.extractHtml("<!doctype html><html><body><h1>Nothing happens</h1></body></html>");
  assert.equal(out.ok, false);
  assert.ok(out.error.includes("no script"));
});

test("an empty reply is refused", () => {
  assert.equal(D.extractHtml("").ok, false);
  assert.equal(D.extractHtml(null).ok, false);
});

test("a working game passes inspection with its signals named", () => {
  const out = D.inspect(GOOD);
  assert.equal(out.ok, true, out.problems.join(" | "));
  assert.ok(out.signals.includes("a canvas"));
  assert.ok(out.signals.includes("an animation loop"));
  assert.ok(out.signals.includes("keyboard input"));
});

test("a game with a canvas but no loop and no input is refused", () => {
  const out = D.inspect("<html><body><canvas width=10 height=10></canvas><script>var x = 1;</script></body></html>");
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.includes("cannot be played")), out.problems.join(" | "));
});

test("a game that loops but never draws is refused", () => {
  const out = D.inspect("<html><body><script>setInterval(function(){var x=1;},100);</script></body></html>");
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.includes("nothing to watch")), out.problems.join(" | "));
});

test("a canvas plus a timed loop passes", () => {
  const out = D.inspect("<html><body><canvas id=c></canvas><script>setInterval(function(){draw();},100);</script></body></html>");
  assert.equal(out.ok, true, out.problems.join(" | "));
  assert.ok(out.signals.includes("a timed loop"));
});

test("outside scripts, network calls and storage are all refused", () => {
  const cases = [
    ["<script src=\"https://cdn.example.com/x.js\"></script>", "outside script"],
    ["<link href=\"https://fonts.example.com/x.css\" rel=\"stylesheet\">", "outside resource"],
    ["fetch('https://api.example.com')", "network"],
    ["var x = new XMLHttpRequest();", "network"],
    ["localStorage.setItem('hi', '1');", "storage"],
    ["window.top.location = 'x';", "out of its own frame"],
    ["@import url(https://example.com/a.css);", "outside stylesheet"]
  ];
  for (const [snippet, why] of cases) {
    const out = D.inspect("<html><head><title>t</title></head><body><canvas></canvas><script>requestAnimationFrame(function l(){requestAnimationFrame(l)});" + snippet + "</script></body></html>");
    assert.equal(out.ok, false, `should refuse: ${snippet}`);
    assert.ok(out.problems.some((p) => p.includes(why)), `${snippet} -> ${out.problems.join(" | ")}`);
  }
});

test("the title comes from the document, with a fallback", () => {
  assert.equal(D.title(GOOD), "Frog Fly Feast");
  assert.equal(D.title("<html><head></head><body><canvas></canvas><script>x</script></body></html>"), "Untitled game");
  assert.equal(D.title("<html><body><h1>Pad Hopper</h1><canvas></canvas><script>x</script></body></html>"), "Pad Hopper");
});

test("the harness is injected into head exactly once", () => {
  const h = D.harness(GOOD);
  assert.equal(h.split("dreamcast: 'running'").length, 2);
  assert.ok(h.indexOf("</head>") > h.indexOf("requestAnimationFrame = function"));
  assert.ok(h.includes("<canvas"));
});

test("the harness is injected even without a head element", () => {
  const frag = "<body><canvas></canvas><script>requestAnimationFrame(function l(){requestAnimationFrame(l)});</script></body>";
  const h = D.harness(frag);
  assert.ok(h.includes("dreamcast: 'running'"));
  assert.ok(h.includes("<canvas"));
});

test("a share token round-trips the game exactly", () => {
  const token = D.encodeShare("a frog game", GOOD);
  const back = D.decodeShare(token);
  assert.equal(back.html, GOOD);
  assert.equal(back.idea, "a frog game");
});

test("a share token survives non-ascii ideas", () => {
  const idea = "a game with \u00e9l\u00e8ves and \u4e2d\u6587 and \ud83d\udc38 frogs";
  const back = D.decodeShare(D.encodeShare(idea, GOOD));
  assert.equal(back.idea, idea);
  assert.equal(back.html, GOOD);
});

test("a share token is url-safe and has no padding", () => {
  const token = D.encodeShare("a frog game", GOOD);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(token), token.slice(0, 40));
});

test("a damaged share token decodes to null rather than throwing", () => {
  assert.equal(D.decodeShare("!!!not base64!!!"), null);
  assert.equal(D.decodeShare(""), null);
  assert.equal(D.decodeShare(null), null);
  const notJson = Buffer.from("plain text, not a payload", "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(D.decodeShare(notJson), null);
  const noHtml = Buffer.from(JSON.stringify({ v: 1, idea: "x" }), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.equal(D.decodeShare(noHtml), null);
});

test("clip shortens on a boundary", () => {
  assert.equal(D.clip("hello", 20), "hello");
  const c = D.clip("a very long idea about frogs and herons", 20);
  assert.ok(c.length <= 20);
  assert.ok(c.endsWith("\u2026"));
});

test("a game larger than the frame limit is refused", () => {
  const huge = "<html><head><title>h</title></head><body><canvas></canvas><script>requestAnimationFrame(function l(){requestAnimationFrame(l)});//" + "x".repeat(D.LIMITS.game) + "</script></body></html>";
  const out = D.extractHtml(huge);
  assert.equal(out.ok, false);
  assert.ok(out.error.includes("too large"));
});
