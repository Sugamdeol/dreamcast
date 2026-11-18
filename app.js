/* Dreamcast - describe a game, get a playable game you can share.
   No build step, no dependencies, no server. Visitors pay with their own Pollen. */

(function () {
  "use strict";

  var D = window.DREAMCAST;

  var CFG = {
    clientId: "pk_4tvFEPh6CAStl7AY",
    authEndpoint: "https://enter.pollinations.ai/authorize",
    tokenEndpoint: "https://enter.pollinations.ai/api/oauth/token",
    userinfoEndpoint: "https://enter.pollinations.ai/api/oauth/userinfo",
    chatEndpoint: "https://gen.pollinations.ai/v1/chat/completions",
    scope: "profile usage",
    models: "text",
    budget: 3,
    expiryDays: 7
  };

  var SYSTEM = [
    "You write one complete, playable browser game as a SINGLE HTML file.",
    "Include <style> and <script> inline. No external files, no imports, no CDN links, no fetch, no storage APIs.",
    "The game must draw to a <canvas> inside an animation loop and read keyboard or pointer input.",
    "It must have a visible score and a clear win or lose condition, and a way to restart.",
    "Use requestAnimationFrame. Keep the whole file under 500 lines.",
    "Declare every variable before you use it, and do not rely on any library.",
    "Reply with the HTML file and nothing else. Do not wrap it in commentary and end with </html>."
  ].join("\n");

  var MODELS = [
    { id: "openai/gpt-5.4-nano", label: "gpt-5.4-nano (default)" },
    { id: "openai/gpt-5.4-mini", label: "gpt-5.4-mini" },
    { id: "openai/gpt-5.6-luna", label: "gpt-5.6-luna" },
    { id: "openai/gpt-5.3-codex", label: "gpt-5.3-codex" }
  ];

  var IDEAS = [
    "A frog on lily pads catching flies with its tongue while herons hunt it",
    "A lighthouse keeper steering ships past rocks with a rotating beam",
    "A paper plane riding updrafts between rooftops, never touching the ground",
    "A tea shop where you serve impatient ghosts before they fade away"
  ];

  var $ = function (sel) { return document.querySelector(sel); };

  var state = {
    token: sessionStorage.getItem("dreamcast.token") || null,
    busy: false,
    game: null,
    idea: "",
    model: MODELS[0].id,
    attempts: [],
    heard: false
  };

  /* ------------------------------------------------------------------ auth */

  function pageUrl() {
    return window.location.origin + window.location.pathname.replace(/index\.html$/, "");
  }

  function b64url(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function rnd(n) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var b = new Uint8Array(n), out = "";
    crypto.getRandomValues(b);
    for (var i = 0; i < n; i += 1) out += alphabet[b[i] % alphabet.length];
    return out;
  }

  function signIn() {
    var verifier = rnd(64), nonce = rnd(24);
    sessionStorage.setItem("dreamcast.verifier", verifier);
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(b64url).then(function (challenge) {
      var params = new URLSearchParams({
        response_type: "code",
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        scope: CFG.scope,
        models: CFG.models,
        budget: String(CFG.budget),
        expiry: String(CFG.expiryDays),
        state: nonce,
        code_challenge: challenge,
        code_challenge_method: "S256"
      });
      window.location.assign(CFG.authEndpoint + "?" + params.toString());
    });
  }

  function finishSignIn() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code"), err = params.get("error");
    if (!code && !err) return Promise.resolve(false);
    if (window.history && window.history.replaceState) window.history.replaceState(null, "", pageUrl());
    if (err) {
      say("Sign in failed: " + err + " " + (params.get("error_description") || ""), "err");
      return Promise.resolve(true);
    }
    var verifier = sessionStorage.getItem("dreamcast.verifier");
    if (!verifier) {
      say("Sign in could not finish because this tab lost its verifier. Sign in again.", "err");
      return Promise.resolve(true);
    }
    say("Finishing sign in...", "");
    return fetch(CFG.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        code_verifier: verifier
      })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d.access_token) {
          throw new Error((d && (d.error_description || d.error)) || ("HTTP " + r.status));
        }
        state.token = d.access_token;
        sessionStorage.setItem("dreamcast.token", state.token);
        sessionStorage.removeItem("dreamcast.verifier");
      });
    }).then(function () {
      say("Signed in. Your own Pollen pays for each game.", "ok");
      return loadUser();
    }).catch(function (e) {
      say("Sign in failed: " + (e && e.message ? e.message : "unknown error"), "err");
    }).then(function () { return true; });
  }

  function loadUser() {
    if (!state.token) {
      $("#who").textContent = "";
      $("#signBtn").textContent = "Sign in with Pollen";
      return Promise.resolve();
    }
    $("#signBtn").textContent = "Sign out";
    $("#who").textContent = "using your Pollen";
    return fetch(CFG.userinfoEndpoint, { headers: { Authorization: "Bearer " + state.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (u) {
        if (u && (u.name || u.username)) $("#who").textContent = "your Pollen: " + (u.name || u.username);
      })
      .catch(function () {});
  }

  /* ------------------------------------------------------------------ model */

  function ask(idea, model) {
    return fetch(CFG.chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + state.token },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: "Game idea: " + D.clip(idea, D.LIMITS.idea) }
        ],
        max_tokens: 16000,
        reasoning_effort: "low"
      })
    }).then(function (r) {
      return r.text().then(function (t) {
        var d;
        try { d = JSON.parse(t); } catch (e) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 180)); }
        if (!r.ok) throw new Error((d.error && (d.error.message || d.error)) || ("HTTP " + r.status));
        var msg = d.choices && d.choices[0] && d.choices[0].message;
        var text = msg && msg.content;
        if (!text) throw new Error("the model returned no game");
        return text;
      });
    });
  }

  /* ------------------------------------------------------------------- frame */

  function loadGame(html) {
    var frame = $("#frame");
    state.heard = false;
    frame.srcdoc = D.harness(html);
    $("#frameNote").textContent = "playing in a sandbox";
  }

  function onFrameMessage(ev) {
    var d = ev.data;
    if (!d || typeof d !== "object" || !d.dreamcast) return;
    if (d.dreamcast === "running") {
      state.heard = true;
      $("#frameNote").textContent = "running";
    } else if (d.dreamcast === "error") {
      state.heard = true;
      addCheck("running", "the running game threw: " + String(d.message || "").slice(0, 140), false);
    } else if (d.dreamcast === "idle") {
      state.heard = true;
      addCheck("running", d.drew
        ? "the game drew a frame but never asked for another, so it may look frozen"
        : "the game never drew a frame, so the screen stays blank", false);
    }
  }

  /* ------------------------------------------------------------------ result */

  function say(text, tone) {
    var el = $("#status");
    el.textContent = text || "";
    el.className = "status" + (tone ? " " + tone : "");
  }

  function addCheck(name, detail, ok) {
    var list = $("#checks");
    $("#checksBox").hidden = false;
    var li = document.createElement("li");
    li.className = ok ? "good" : "bad";
    li.textContent = name + ": " + detail;
    list.appendChild(li);
  }

  function clearChecks() {
    $("#checks").innerHTML = "";
    $("#checksBox").hidden = true;
    $("#attempts").innerHTML = "";
    $("#attemptsBox").hidden = true;
  }

  function addAttempt(model, outcome) {
    var list = $("#attempts");
    $("#attemptsBox").hidden = false;
    var li = document.createElement("li");
    var b = document.createElement("b");
    b.textContent = model.replace("openai/", "");
    li.appendChild(b);
    li.appendChild(document.createTextNode(" " + outcome));
    list.appendChild(li);
    /* Keep one line per model: the last word on that model wins. */
    for (var i = 0; i < list.children.length - 1; i += 1) {
      if (list.children[i].querySelector("b").textContent === b.textContent) {
        list.removeChild(list.children[i]);
        break;
      }
    }
  }

  function pills(items) {
    var box = $("#gamePills");
    box.innerHTML = "";
    items.forEach(function (t) {
      var s = document.createElement("span");
      s.className = "pill";
      s.textContent = t;
      box.appendChild(s);
    });
  }

  function showGame(game) {
    state.game = game;
    $("#gameTitle").textContent = game.title;
    $("#titleBox").hidden = false;
    pills(["idea: " + D.clip(game.idea, 70), "model: " + game.model.replace("openai/", ""), (game.html.length / 1024).toFixed(1) + " KB inline"]);
    loadGame(game.html);
    $("#restartBtn").hidden = false;
    $("#openBtn").hidden = false;
    $("#againBtn").hidden = false;

    var url = window.location.origin + window.location.pathname + "#" + D.encodeShare(game.idea, game.html);
    $("#shareUrl").value = url;
    $("#shareBox").hidden = false;
    if (window.history && window.history.replaceState) window.history.replaceState(null, "", "#" + D.encodeShare(game.idea, game.html));
  }

  /* Ask one model, check what comes back, and only then show it. */
  function tryModel(model, idea, isLast) {
    addAttempt(model, "asking...");
    return ask(idea, model).then(function (raw) {
      var extracted = D.extractHtml(raw);
      if (!extracted.ok) {
        addAttempt(model, "no usable game (" + extracted.error + ")");
        addCheck("shape", model.replace("openai/", "") + ": " + extracted.error, false);
        throw new Error(extracted.error);
      }
      var report = D.inspect(extracted.html);
      if (!report.ok) {
        addAttempt(model, "the game failed the safety checks");
        report.problems.forEach(function (p) { addCheck("contents", p, false); });
        throw new Error(report.problems[0]);
      }
      addAttempt(model, "produced a full game");
      addCheck("shape", "a complete html file with its own script", true);
      addCheck("contents", "no outside scripts, no network calls, no storage", true);
      addCheck("gameplay", "it has " + report.signals.join(", "), true);
      return { html: extracted.html, model: model, idea: idea, title: D.title(extracted.html) };
    }, function (e) {
      addAttempt(model, "the call failed (" + (e && e.message ? e.message : "unknown error") + ")");
      throw e;
    });
  }

  function makeGame() {
    if (state.busy) return;
    if (!state.token) { say("Sign in with Pollinations first, so the model is paid from your own balance.", "err"); return; }
    var idea = $("#idea").value.trim();
    if (idea.length < 8) { say("Describe the game in a sentence or two first.", "err"); return; }

    state.busy = true;
    state.idea = idea;
    state.model = $("#model").value;
    state.attempts = [];
    clearChecks();
    $("#shareBox").hidden = true;
    $("#titleBox").hidden = true;
    $("#restartBtn").hidden = true;
    $("#openBtn").hidden = true;
    $("#againBtn").hidden = true;
    $("#makeBtn").disabled = true;
    $("#makeBtn").textContent = "Writing the game...";
    $("#bar").hidden = false;
    var fill = $("#barFill");
    var pct = 8;
    fill.style.width = pct + "%";
    var tick = window.setInterval(function () {
      pct = Math.min(92, pct + Math.random() * 4);
      fill.style.width = pct + "%";
    }, 700);
    say("Asking " + state.model.replace("openai/", "") + " for the whole game in one file...", "");

    tryModel(state.model, idea, true).then(function (game) {
      fill.style.width = "100%";
      showGame(game);
      say("Game ready. It ran in a sandboxed frame; use the keys it names.", "ok");
    }).catch(function (e) {
      fill.style.width = "100%";
      /* A model that throws or misbehaves is worth one fallback, never a retry loop. */
      var order = ["openai/gpt-5.4-mini", "openai/gpt-5.3-codex", "openai/gpt-5.6-luna", "openai/gpt-5.4-nano"];
      var fallback = order.filter(function (id) { return id !== state.model; })[0];
      say("That model did not produce a playable game (" + (e && e.message ? e.message : "unknown error") + "). Trying " + fallback.replace("openai/", "") + "...", "err");
      return tryModel(fallback, idea, true).then(function (game) {
        showGame(game);
        say("The first model did not finish, so this game came from " + fallback.replace("openai/", "") + ".", "ok");
      });
    }).catch(function (e) {
      say("No playable game came back this time: " + (e && e.message ? e.message : "unknown error") + ". Edit the idea and try again.", "err");
    }).then(function () {
      window.clearInterval(tick);
      state.busy = false;
      $("#makeBtn").disabled = false;
      $("#makeBtn").textContent = "Make the game";
      $("#bar").hidden = true;
    });
  }

  /* ------------------------------------------------------------------ share */

  function copyShare() {
    var input = $("#shareUrl");
    input.select();
    var done = function () { say("Share link copied. It carries the whole game.", "ok"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done).catch(function () { say("Copy the link from the box by hand.", "err"); });
    } else {
      try { document.execCommand("copy"); done(); } catch (e) { say("Copy the link from the box by hand.", "err"); }
    }
  }

  function openGame() {
    if (!state.game) return;
    var w = window.open("", "_blank");
    if (!w) { say("The browser blocked the new tab. Allow pop-ups for this page.", "err"); return; }
    w.document.write(state.game.html);
    w.document.close();
  }

  function restoreFromLink() {
    var token = (window.location.hash || "").replace(/^#/, "");
    if (!token) return false;
    var shared = D.decodeShare(token);
    if (!shared) return false;
    var report = D.inspect(shared.html);
    if (!report.ok) {
      say("That share link carries a game that failed its checks, so it was not loaded.", "err");
      return false;
    }
    state.idea = shared.idea;
    $("#idea").value = shared.idea;
    showGame({ html: shared.html, model: "from a shared link", idea: shared.idea, title: D.title(shared.html) });
    addCheck("share link", "the game in this link passed the same checks it passed when it was made", true);
    say("Loaded from a share link. Anyone with this link can play it.", "ok");
    return true;
  }

  /* A link pasted into the address bar changes the hash without reloading the
     page, so the app has to notice that itself. */
  function watchHash() {
    window.addEventListener("hashchange", function () {
      if (state.busy) return;
      var token = (window.location.hash || "").replace(/^#/, "");
      if (!token) return;
      if (state.game && D.encodeShare(state.game.idea, state.game.html) === token) return;
      restoreFromLink();
    });
  }

  /* ------------------------------------------------------------------ wiring */

  function buildIdeas() {
    var box = $("#ideas");
    IDEAS.forEach(function (text) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "idea";
      b.textContent = text.length > 54 ? text.slice(0, 53) + "\u2026" : text;
      b.addEventListener("click", function () { $("#idea").value = text; say("Idea set. Make the game when ready.", ""); });
      box.appendChild(b);
    });
  }

  function buildModels() {
    var sel = $("#model");
    MODELS.forEach(function (m) {
      var o = document.createElement("option");
      o.value = m.id;
      o.textContent = m.label;
      sel.appendChild(o);
    });
    sel.value = MODELS[0].id;
  }

  function init() {
    buildIdeas();
    buildModels();
    window.addEventListener("message", onFrameMessage);
    $("#makeBtn").addEventListener("click", makeGame);
    $("#againBtn").addEventListener("click", makeGame);
    $("#restartBtn").addEventListener("click", function () {
      if (state.game) { loadGame(state.game.html); say("Game restarted.", "ok"); }
    });
    $("#openBtn").addEventListener("click", openGame);
    $("#copyShare").addEventListener("click", copyShare);
    $("#signBtn").addEventListener("click", function () {
      if (state.token) {
        state.token = null;
        sessionStorage.removeItem("dreamcast.token");
        loadUser();
        say("Signed out.", "");
        return;
      }
      signIn();
    });
    $("#idea").addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") makeGame();
    });
    finishSignIn().then(function () {
      loadUser();
      if (!restoreFromLink()) say("", "");
    });
    watchHash();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
