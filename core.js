/* Dreamcast - the rules for turning a model reply into a game you can trust.
   Pure functions only: no DOM, no network, no globals. */

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DREAMCAST = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var LIMITS = { idea: 500, game: 120000, title: 60 };
  var BANNED = [
    { re: /<script[^>]+src\s*=/i, why: "loads an outside script" },
    { re: /@import\s+url/i, why: "imports an outside stylesheet" },
    { re: /\bimport\s+[\w{*]/i, why: "uses a module import" },
    { re: /<link[^>]+href\s*=\s*["']?https?:/i, why: "links to an outside resource" },
    { re: /\bfetch\s*\(/i, why: "calls the network" },
    { re: /XMLHttpRequest/i, why: "calls the network" },
    { re: /\b(?:localStorage|indexedDB)\b/i, why: "writes to browser storage" },
    { re: /window\.(?:top|parent)\b/i, why: "reaches out of its own frame" }
  ];
  var SIGNALS = [
    { re: /<canvas[\s>]/i, kind: "view", why: "a canvas" },
    { re: /requestAnimationFrame/i, kind: "drive", why: "an animation loop" },
    { re: /setInterval\s*\(/i, kind: "drive", why: "a timed loop" },
    { re: /addEventListener\(\s*["']key/i, kind: "drive", why: "keyboard input" },
    { re: /onkey(?:down|up)\s*=/i, kind: "drive", why: "keyboard input" },
    { re: /<(?:button|input)[\s>]/i, kind: "drive", why: "on-screen controls" },
    { re: /addEventListener\(\s*["'](?:click|pointer|mouse)/i, kind: "drive", why: "pointer input" },
    { re: /touch(?:start|move|end)/i, kind: "drive", why: "touch input" }
  ];

  function clip(value, max) {
    var s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1).replace(/[\s,;:.]$/, "") + "\u2026";
  }

  /* Models wrap the file in a markdown fence, or add a sentence before it.
     Take the html document out of whatever came back. */
  function extractHtml(text) {
    var s = String(text == null ? "" : text).trim();
    if (!s) return { ok: false, error: "the reply was empty" };
    var fenced = s.match(/```(?:html)?\s*([\s\S]*?)```/i);
    var candidate = fenced ? fenced[1].trim() : s;

    var start = candidate.search(/<!doctype\s+html|<html[\s>]/i);
    if (start === -1) {
      /* Some models reply with a bare fragment: <style>...<script>... */
      if (/<script[\s>]/i.test(candidate)) {
        candidate = "<!doctype html>\n<html>\n<head><meta charset=\"utf-8\"><title>Dreamcast game</title></head>\n<body>\n" +
          candidate + "\n</body>\n</html>";
        start = 0;
      } else {
        return { ok: false, error: "the reply had no html document in it" };
      }
    } else {
      candidate = candidate.slice(start);
    }

    var ends = candidate.toLowerCase().lastIndexOf("</html>");
    if (ends !== -1) candidate = candidate.slice(0, ends + 7);
    else if (/<script[\s>]/i.test(candidate)) candidate += "\n</body>\n</html>";

    if (!/<script[\s>]/i.test(candidate)) {
      return { ok: false, error: "the game had no script, so nothing would happen" };
    }
    if (candidate.length > LIMITS.game) {
      return { ok: false, error: "the game was too large to run in a frame" };
    }
    return { ok: true, html: candidate };
  }

  /* Static checks, before the frame is ever built. A game needs something to
     look at AND something to do: a canvas alone, or a bare loop with nothing
     on screen, is not a game. */
  function inspect(html) {
    var src = String(html || "");
    var problems = [];
    BANNED.forEach(function (b) {
      if (b.re.test(src)) problems.push("the game " + b.why);
    });
    var found = SIGNALS.filter(function (s) { return s.re.test(src); });
    var unique = [];
    found.forEach(function (s) { if (unique.indexOf(s.why) === -1) unique.push(s.why); });
    var hasView = found.some(function (s) { return s.kind === "view"; });
    var hasDrive = found.some(function (s) { return s.kind === "drive"; });
    if (!hasView && !hasDrive) problems.push("the game has no canvas, no loop and no input, so there is nothing to play");
    else if (!hasView) problems.push("the game never draws anything, so there is nothing to watch");
    else if (!hasDrive) problems.push("the game never reads input and never loops, so it cannot be played");
    return { problems: problems, signals: unique, ok: problems.length === 0 };
  }

  function title(html) {
    var m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m && m[1] && m[1].trim()) return clip(m[1], LIMITS.title);
    var h = String(html || "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h) return clip(h[1].replace(/<[^>]*>/g, ""), LIMITS.title);
    return "Untitled game";
  }

  /* The wrapper the game runs inside. It reports back whether the game ever
     drew a frame and whether it threw, so the page can tell a working game
     from one that only looks finished. */
  function harness(gameHtml) {
    var guard = [
      "(function () {",
      "  var reported = false, drew = false, thrown = null;",
      "  function send(msg) { try { parent.postMessage(msg, '*'); } catch (e) {} }",
      "  window.addEventListener('error', function (e) {",
      "    if (!thrown) { thrown = String((e && (e.message || e.error)) || 'a script error').slice(0, 220); }",
      "    send({ dreamcast: 'error', message: thrown });",
      "  });",
      "  var originalRaf = window.requestAnimationFrame;",
      "  window.requestAnimationFrame = function (fn) {",
      "    return originalRaf.call(window, function (t) {",
      "      if (!drew) {",
      "        try {",
      "          var c = document.querySelector('canvas');",
      "          if (c && c.width && c.height) {",
      "            var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;",
      "            for (var i = 3; i < d.length; i += 397) { if (d[i] !== 0) { drew = true; break; } }",
      "          } else { drew = true; }",
      "        } catch (e) { drew = true; }",
      "        if (drew && !reported) { reported = true; send({ dreamcast: 'running' }); }",
      "      }",
      "      return fn(t);",
      "    });",
      "  };",
      "  setTimeout(function () {",
      "    if (!reported) { send({ dreamcast: 'idle', drew: drew, thrown: thrown }); }",
      "  }, 5000);",
      "})();"
    ].join("\n");

    var withGuard = gameHtml.replace(/<head([^>]*)>/i, "<head$1>\n<script>" + guard + "</script>");
    if (withGuard === gameHtml) withGuard = "<script>" + guard + "</script>\n" + gameHtml;
    return withGuard;
  }

  /* Share link: the whole game rides in the fragment, so the link needs no
     server and the game is exactly the one that was checked. */
  function encodeShare(idea, html) {
    var payload = JSON.stringify({ v: 1, idea: clip(idea, LIMITS.idea), html: html });
    return base64UrlEncode(payload);
  }

  function decodeShare(token) {
    try {
      var parsed = JSON.parse(base64UrlDecode(token));
      if (!parsed || typeof parsed.html !== "string" || !parsed.html) return null;
      return { idea: String(parsed.idea || ""), html: parsed.html };
    } catch (e) {
      return null;
    }
  }

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  function base64UrlEncode(str) {
    var bytes = utf8Bytes(str), out = "";
    for (var i = 0; i < bytes.length; i += 3) {
      var b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
      out += B64[b0 >> 2];
      out += B64[((b0 & 3) << 4) | ((b1 || 0) >> 4)];
      out += i + 1 < bytes.length ? B64[((b1 & 15) << 2) | ((b2 || 0) >> 6)] : "=";
      out += i + 2 < bytes.length ? B64[b2 & 63] : "=";
    }
    return out.replace(/=+$/, "");
  }

  function base64UrlDecode(token) {
    var s = String(token || "").replace(/[^A-Za-z0-9_-]/g, "");
    var bytes = [];
    for (var i = 0; i < s.length; i += 4) {
      var n = s.length - i;
      var c0 = B64.indexOf(s[i]), c1 = B64.indexOf(s[i + 1]);
      var c2 = n > 2 ? B64.indexOf(s[i + 2]) : -1, c3 = n > 3 ? B64.indexOf(s[i + 3]) : -1;
      bytes.push((c0 << 2) | (c1 >> 4));
      if (c2 !== -1) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 !== -1) bytes.push(((c2 & 3) << 6) | c3);
    }
    return utf8String(bytes);
  }

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i += 1) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var next = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i += 1;
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function utf8String(bytes) {
    var out = "", i = 0;
    while (i < bytes.length) {
      var b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
      else if (b < 0xe0) { out += String.fromCharCode(((b & 31) << 6) | (bytes[i + 1] & 63)); i += 2; }
      else if (b < 0xf0) { out += String.fromCharCode(((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)); i += 3; }
      else {
        var cp = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
        i += 4;
      }
    }
    return out;
  }

  return {
    LIMITS: LIMITS, extractHtml: extractHtml, inspect: inspect, title: title,
    harness: harness, encodeShare: encodeShare, decodeShare: decodeShare,
    clip: clip
  };
});
