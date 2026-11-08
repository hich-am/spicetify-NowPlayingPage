/* Now Playing: one track, one thin bar, an optional quiet list,
   an optional soundwave, and a fill-the-window mode. */

const npR = Spicetify.React;
const { useState: npUseState, useEffect: npUseEffect, useRef: npUseRef } = npR;
const h = npR.createElement;

const NP_KEYS = { mode: "retrocalm:np:mode", wave: "retrocalm:np:wave", lyrics: "retrocalm:np:lyrics", grain: "retrocalm:np:grain" };

const npClamp = (n, a, b) => Math.min(b, Math.max(a, n));

const npLoad = (key, allowed, fallback) => {
  try {
    const v = Spicetify.LocalStorage.get(key);
    return allowed.includes(v) ? v : fallback;
  } catch (e) { return fallback; }
};
const npSave = (key, value) => { try { Spicetify.LocalStorage.set(key, value); } catch (e) {} };

const npImg = (u) => {
  if (!u) return "";
  return u.startsWith("spotify:image:") ? "https://i.scdn.co/image/" + u.slice(14) : u;
};

const npFromItem = (item) => {
  if (!item) return null;
  const md = item.metadata || {};
  return {
    uri: item.uri,
    title: item.name || md.title || "Unknown track",
    artist: (item.artists && item.artists.map((a) => a.name).join(", ")) || md.artist_name || "",
    album: (item.album && item.album.name) || md.album_title || "",
    cover: npImg(md.image_xlarge_url || md.image_url || (item.images && item.images[0] && item.images[0].url) || (item.album && item.album.images && item.album.images[0] && item.album.images[0].url)),
  };
};

const npFromQueue = (entry) => {
  const t = (entry && entry.contextTrack) || entry || {};
  const md = t.metadata || {};
  return { uri: t.uri, title: md.title || "Unknown track", artist: md.artist_name || "", cover: npImg(md.image_small_url || md.image_url) };
};

const npFmt = (ms) => {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

/* ---------- Player state ---------- */

function useNowPlaying() {
  const [track, setTrack] = npUseState(() => npFromItem(Spicetify.Player.data && Spicetify.Player.data.item));
  const [playing, setPlaying] = npUseState(() => Spicetify.Player.isPlaying());
  const [queue, setQueue] = npUseState({ next: [], prev: [] });

  npUseEffect(() => {
    const readQueue = () => {
      try {
        const q = Spicetify.Queue || {};
        setQueue({
          next: (q.nextTracks || []).slice(0, 8).map(npFromQueue).filter((t) => t.uri),
          prev: (q.prevTracks || []).slice(-8).reverse().map(npFromQueue).filter((t) => t.uri),
        });
      } catch (e) { /* queue not ready */ }
    };
    const onSong = () => {
      setTrack(npFromItem(Spicetify.Player.data && Spicetify.Player.data.item));
      setTimeout(readQueue, 400);
    };
    const onPlayPause = () => setPlaying(Spicetify.Player.isPlaying());

    Spicetify.Player.addEventListener("songchange", onSong);
    Spicetify.Player.addEventListener("onplaypause", onPlayPause);
    let events = null;
    try {
      events = Spicetify.Platform.PlayerAPI._events;
      events.addListener("queue_update", readQueue);
    } catch (e) { events = null; }
    readQueue();

    return () => {
      Spicetify.Player.removeEventListener("songchange", onSong);
      Spicetify.Player.removeEventListener("onplaypause", onPlayPause);
      try { if (events) events.removeListener("queue_update", readQueue); } catch (e) {}
    };
  }, []);

  return { track, playing, queue };
}

/* ---------- Soundwave ---------- */
/* Level sources return 0..1 for a time in seconds.
   1) Real: Spotify's audio analysis (loudness per segment + beats), if available.
   2) Fallback: a calm, deterministic wave seeded by the track, with a soft pulse. */

function npSyntheticSource(uri) {
  let s = 7;
  for (const c of String(uri || "x")) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  const r = (n) => ((s >>> n) & 255) / 255;
  const bpm = 84 + r(0) * 50, f1 = 0.35 + r(8) * 0.5, f2 = 0.9 + r(16) * 0.8, p = r(24) * 6;
  return {
    level: (t) => {
      const pulse = Math.exp(-((t * bpm / 60) % 1) * 5) * 0.26;
      return npClamp(0.38 + 0.16 * Math.sin(t * f1 * 2 + p) + 0.1 * Math.sin(t * f2 * 3) + pulse, 0, 1);
    },
  };
}

function npAnalysisSource(d) {
  const seg = d.segments, beats = d.beats || [];
  let si = 0, bi = 0;
  return {
    level: (t) => {
      if (t < seg[si].start) si = 0;
      while (si < seg.length - 1 && seg[si + 1].start <= t) si++;
      const loud = typeof seg[si].loudness_max === "number" ? seg[si].loudness_max : -30;
      const base = npClamp((loud + 35) / 35, 0, 1);
      let pulse = 0;
      if (beats.length) {
        if (t < beats[bi].start) bi = 0;
        while (bi < beats.length - 1 && beats[bi + 1].start <= t) bi++;
        pulse = Math.exp(-Math.max(0, t - beats[bi].start) * 6) * 0.22;
      }
      return npClamp(base * 0.85 + pulse, 0, 1);
    },
  };
}

const NP_LAYERS = [
  { amp: 1.0, freq: 1.1, speed: 1.0, alpha: 0.14, line: true },
  { amp: 0.7, freq: 1.8, speed: -0.7, alpha: 0.09, line: false },
  { amp: 0.45, freq: 2.6, speed: 1.3, alpha: 0.06, line: false },
];

const NP_WAVES = ["off", "waves", "line", "bars", "ring"];
const NP_WAVE_LABELS = { off: "Off", waves: "Waves", line: "Line", bars: "Bars", ring: "Ring" };

const NP_DRAW = {
  /* Three soft layered swells along the bottom. */
  waves(ctx, w, hgt, lvl, phase, rgb) {
    NP_LAYERS.forEach((L) => {
      const A = hgt * 0.09 * (0.12 + lvl * L.amp);
      const base = hgt * 0.84;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const u = (x / w) * Math.PI * 2;
        const y = base + Math.sin(u * L.freq + phase * L.speed) * A + Math.sin(u * L.freq * 2.3 - phase * L.speed * 1.4) * A * 0.4;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (L.line) {
        ctx.strokeStyle = "rgba(" + rgb + ",0.35)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.lineTo(w, hgt); ctx.lineTo(0, hgt); ctx.closePath();
      ctx.fillStyle = "rgba(" + rgb + "," + L.alpha + ")";
      ctx.fill();
    });
  },

  /* A single thin oscilloscope line that tapers to nothing at the edges. */
  line(ctx, w, hgt, lvl, phase, rgb) {
    const base = hgt * 0.86;
    const A = hgt * 0.05 * (0.15 + lvl);
    [{ o: 0, a: 0.4, lw: 1.5, k: 1 }, { o: 14, a: 0.14, lw: 1, k: 0.6 }].forEach((L) => {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 4) {
        const u = (x / w) * Math.PI * 2;
        const env = Math.sin((x / w) * Math.PI);
        const y = base + L.o + (Math.sin(u * 3 + phase * 1.6) * 0.6 + Math.sin(u * 7 - phase * 2.3) * 0.3 + Math.sin(u * 13 + phase * 3.1) * 0.1) * A * L.k * env;
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "rgba(" + rgb + "," + L.a + ")";
      ctx.lineWidth = L.lw;
      ctx.stroke();
    });
  },

  /* Soft rounded bars rising from the bottom edge. */
  bars(ctx, w, hgt, lvl, phase, rgb) {
    const n = Math.max(24, Math.round(w / 18));
    const step = w / n;
    const bw = Math.max(2, step * 0.42);
    ctx.fillStyle = "rgba(" + rgb + ",0.16)";
    for (let i = 0; i < n; i++) {
      const v = (0.5 + 0.5 * Math.sin(i * 0.35 + phase * 1.8)) * (0.5 + 0.5 * Math.sin(i * 0.13 - phase * 0.9));
      const env = 0.55 + 0.45 * Math.sin((i / (n - 1)) * Math.PI);
      const bh = hgt * 0.17 * (0.06 + lvl * v * 1.15) * env + 3;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(i * step + (step - bw) / 2, hgt - bh - hgt * 0.04, bw, bh, bw / 2);
      else ctx.rect(i * step + (step - bw) / 2, hgt - bh - hgt * 0.04, bw, bh);
      ctx.fill();
    }
  },

  /* Slow breathing rings behind the track, with a faint glow. */
  ring(ctx, w, hgt, lvl, phase, rgb) {
    const cx = w / 2, cy = hgt * 0.46;
    const r0 = Math.min(w, hgt) * 0.3;
    const breathe = 1 + 0.025 * Math.sin(phase * 0.7) + lvl * 0.07;
    const g = ctx.createRadialGradient(cx, cy, r0 * 0.2, cx, cy, r0 * 1.5 * breathe);
    g.addColorStop(0, "rgba(" + rgb + "," + (0.07 + lvl * 0.05) + ")");
    g.addColorStop(1, "rgba(" + rgb + ",0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, hgt);
    [{ k: 1, a: 0.2, lw: 1.4 }, { k: 1.18, a: 0.11, lw: 1 }, { k: 1.38, a: 0.06, lw: 1 }].forEach((R, i) => {
      const wob = 1 + 0.012 * Math.sin(phase * 1.1 + i * 1.7) * (0.3 + lvl);
      ctx.beginPath();
      ctx.arc(cx, cy, r0 * R.k * breathe * wob, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(" + rgb + "," + R.a + ")";
      ctx.lineWidth = R.lw;
      ctx.stroke();
    });
  },
};

function NpWave({ track, playing, waveStyle }) {
  const styleRef = npUseRef(waveStyle);
  styleRef.current = waveStyle;
  const canvasRef = npUseRef(null);
  const playingRef = npUseRef(playing);
  const sourceRef = npUseRef(null);
  playingRef.current = playing;
  const uri = track && track.uri;

  npUseEffect(() => {
    let dead = false;
    sourceRef.current = npSyntheticSource(uri);
    if (uri && Spicetify.getAudioData) {
      Promise.race([
        Spicetify.getAudioData(uri),
        new Promise((_, reject) => setTimeout(reject, 4000)),
      ]).then((d) => {
        if (!dead && d && d.segments && d.segments.length) sourceRef.current = npAnalysisSource(d);
      }).catch(() => { /* keep the synthetic wave */ });
    }
    return () => { dead = true; };
  }, [uri]);

  npUseEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0, lvl = 0.05, phase = 0, last = performance.now(), w = 0, hgt = 0, frames = 0;
    let rgb = "233,162,59";

    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth; hgt = canvas.clientHeight;
      canvas.width = Math.max(1, w * dpr); canvas.height = Math.max(1, hgt * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(canvas);

    const frame = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (frames++ % 120 === 0) {
        const v = getComputedStyle(document.documentElement).getPropertyValue("--spice-rgb-button").trim();
        if (v) rgb = v;
      }
      let target = 0.05;
      if (reduce) target = 0.2;
      else if (playingRef.current && sourceRef.current) target = sourceRef.current.level(Spicetify.Player.getProgress() / 1000);
      lvl += (target - lvl) * Math.min(1, dt * 6);
      phase += reduce ? 0 : dt * (0.4 + lvl * 1.2);

      ctx.clearRect(0, 0, w, hgt);
      (NP_DRAW[styleRef.current] || NP_DRAW.waves)(ctx, w, hgt, lvl, phase, rgb);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  return h("canvas", { className: "np-wave", ref: canvasRef, "aria-hidden": true });
}

/* ---------- Pieces ---------- */

function NpProgress() {
  const [pos, setPos] = npUseState(Spicetify.Player.getProgress());
  const [dur, setDur] = npUseState(Spicetify.Player.getDuration());
  npUseEffect(() => {
    const id = setInterval(() => {
      setPos(Spicetify.Player.getProgress());
      setDur(Spicetify.Player.getDuration());
    }, 500);
    return () => clearInterval(id);
  }, []);

  const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
  const seek = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (dur) Spicetify.Player.seek(Math.round(npClamp((e.clientX - r.left) / r.width, 0, 1) * dur));
  };
  const onKey = (e) => {
    if (e.key === "ArrowRight") Spicetify.Player.seek(Math.min(dur, pos + 5000));
    if (e.key === "ArrowLeft") Spicetify.Player.seek(Math.max(0, pos - 5000));
  };

  return h("div", { className: "np-progress" },
    h("span", { className: "np-time" }, npFmt(pos)),
    h("div", {
      className: "np-bar", role: "slider", tabIndex: 0, "aria-label": "Seek",
      "aria-valuemin": 0, "aria-valuemax": Math.round(dur / 1000), "aria-valuenow": Math.round(pos / 1000),
      onClick: seek, onKeyDown: onKey,
    }, h("div", { className: "np-bar-fill", style: { width: pct + "%" } })),
    h("span", { className: "np-time np-time-end" }, npFmt(dur))
  );
}

const npIcon = (d, label) =>
  h("svg", { viewBox: "0 0 24 24", width: 20, height: 20, fill: "currentColor", role: "img", "aria-label": label }, h("path", { d }));

const npStroke = (d) =>
  h("svg", { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("path", { d }));

const NP_PATHS = {
  prev: "M6 5h2v14H6zM20 5v14L9 12z",
  next: "M16 5h2v14h-2zM4 5l11 7L4 19z",
  play: "M8 5v14l11-7z",
  pause: "M7 5h3.5v14H7zM13.5 5H17v14h-3.5z",
  wave: "M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2",
  lines: "M4 7h16M4 12h10M4 17h13",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
  repeatOne: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3M11.5 10.5l1.5-1v6",
  vol0: "M11 5 6 9H3v6h3l5 4zM16 9l5 6M21 9l-5 6",
  vol1: "M11 5 6 9H3v6h3l5 4zM15.5 9a4 4 0 0 1 0 6",
  vol2: "M11 5 6 9H3v6h3l5 4zM15.5 9a4 4 0 0 1 0 6M18.5 6a8 8 0 0 1 0 12",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  shrink: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
};

function NpList({ items, empty }) {
  if (!items.length) return h("p", { className: "np-empty" }, empty);
  return h("ul", { className: "np-list" }, items.map((t, i) =>
    h("li", { key: t.uri + i },
      h("button", { className: "np-row", onClick: () => Spicetify.Player.playUri(t.uri), title: "Play " + t.title },
        h("span", { className: "np-row-art", style: t.cover ? { backgroundImage: "url(" + t.cover + ")" } : null }),
        h("span", { className: "np-row-text" },
          h("span", { className: "np-row-title" }, t.title),
          h("span", { className: "np-row-artist" }, t.artist)))
    )
  ));
}

/* ---------- Shuffle, repeat, volume ---------- */

function NpModes() {
  const [shuffle, setShuffle] = npUseState(() => !!Spicetify.Player.getShuffle());
  const [repeat, setRepeat] = npUseState(() => Spicetify.Player.getRepeat() || 0);
  npUseEffect(() => {
    const id = setInterval(() => {
      setShuffle(!!Spicetify.Player.getShuffle());
      setRepeat(Spicetify.Player.getRepeat() || 0);
    }, 800);
    return () => clearInterval(id);
  }, []);

  const repeatLabel = ["Repeat off", "Repeat all", "Repeat one"][repeat] || "Repeat off";
  return h(npR.Fragment, null,
    h("button", {
      className: "np-mode" + (shuffle ? " is-on" : ""), "aria-pressed": shuffle,
      title: shuffle ? "Shuffle on" : "Shuffle off", "aria-label": "Shuffle",
      onClick: () => { Spicetify.Player.toggleShuffle(); setShuffle((v) => !v); },
    }, npStroke(NP_PATHS.shuffle)),
    h("button", {
      className: "np-mode" + (repeat ? " is-on" : ""), "aria-pressed": repeat > 0,
      title: repeatLabel, "aria-label": repeatLabel,
      onClick: () => { Spicetify.Player.toggleRepeat(); setRepeat((r) => (r + 1) % 3); },
    }, npStroke(repeat === 2 ? NP_PATHS.repeatOne : NP_PATHS.repeat)));
}

function NpVolume() {
  const [vol, setVol] = npUseState(() => Spicetify.Player.getVolume());
  const [muted, setMuted] = npUseState(() => !!Spicetify.Player.getMute());
  const dragging = npUseRef(false);

  npUseEffect(() => {
    const id = setInterval(() => {
      if (!dragging.current) setVol(Spicetify.Player.getVolume());
      setMuted(!!Spicetify.Player.getMute());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const shown = muted ? 0 : vol;
  const pct = Math.round(shown * 100);
  const onChange = (e) => {
    const v = npClamp(Number(e.target.value) / 100, 0, 1);
    dragging.current = true;
    setVol(v);
    Spicetify.Player.setVolume(v);
    if (muted) { try { Spicetify.Player.setMute(false); } catch (err) {} setMuted(false); }
  };
  const release = () => { setTimeout(() => { dragging.current = false; }, 300); };
  const icon = shown === 0 ? NP_PATHS.vol0 : shown < 0.5 ? NP_PATHS.vol1 : NP_PATHS.vol2;

  return h("div", { className: "np-volume" },
    h("input", {
      type: "range", className: "np-range", min: 0, max: 100, step: 1, value: pct,
      "aria-label": "Volume", style: { "--v": pct + "%" },
      onChange, onPointerUp: release, onBlur: release,
    }),
    h("button", {
      className: "np-mode", title: muted ? "Unmute" : "Mute", "aria-label": muted ? "Unmute" : "Mute",
      onClick: () => { Spicetify.Player.toggleMute(); setMuted((m) => !m); },
    }, npStroke(icon)));
}

/* ---------- Lyrics ---------- */
/* Sources, in order: Spotify's own lyrics service, then LRCLIB (free, community-run).
   Synced lyrics highlight line by line; unsynced lyrics are plain and scrollable. */

const npLyricsCache = new Map();

const npWithTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

function npParseLrc(text) {
  const out = [];
  String(text || "").split("\n").forEach((raw) => {
    const m = raw.match(/^\s*((?:\[\d+:\d+(?:[.:]\d+)?\])+)\s*(.*)$/);
    if (!m) return;
    const words = m[2].trim();
    m[1].replace(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g, (_, mm, ss, fr) => {
      out.push({ t: (Number(mm) * 60 + Number(ss) + (fr ? Number("0." + fr) : 0)) * 1000, text: words });
      return "";
    });
  });
  return out.sort((a, b) => a.t - b.t);
}

async function npFetchSpotifyLyrics(track) {
  const uri = String(track.uri || "");
  if (!uri.startsWith("spotify:track:")) return null;
  const id = uri.split(":")[2];
  const img = track.cover ? "/image/" + encodeURIComponent(track.cover) : "";
  const url = "https://spclient.wg.spotify.com/color-lyrics/v2/track/" + id + img + "?format=json&vocalRemoval=false&market=from_token";
  const res = await npWithTimeout(Spicetify.CosmosAsync.get(url), 6000);
  const L = res && res.lyrics;
  if (!L || !L.lines || !L.lines.length) return null;
  const synced = L.syncType === "LINE_SYNCED";
  return {
    synced,
    source: "Spotify",
    lines: L.lines.map((l) => ({ t: synced ? Number(l.startTimeMs) : null, text: l.words || "" })),
  };
}

async function npGetJson(url) {
  try {
    const res = await npWithTimeout(fetch(url), 6000);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return npWithTimeout(Spicetify.CosmosAsync.get(url), 6000);
  }
}

async function npFetchLrclib(track) {
  const q = new URLSearchParams({
    track_name: track.title,
    artist_name: (track.artist || "").split(",")[0].trim(),
    album_name: track.album || "",
    duration: String(Math.round(Spicetify.Player.getDuration() / 1000)),
  });
  const d = await npGetJson("https://lrclib.net/api/get?" + q.toString());
  if (!d) return null;
  if (d.syncedLyrics) {
    const lines = npParseLrc(d.syncedLyrics);
    if (lines.length) return { synced: true, source: "LRCLIB", lines };
  }
  if (d.plainLyrics) {
    return { synced: false, source: "LRCLIB", lines: d.plainLyrics.split("\n").map((t) => ({ t: null, text: t.trim() })) };
  }
  return null;
}

function useLyrics(track, enabled) {
  const [state, setState] = npUseState({ status: "idle", data: null });
  const uri = track && track.uri;

  npUseEffect(() => {
    if (!enabled || !track) { setState({ status: "idle", data: null }); return undefined; }
    if (npLyricsCache.has(uri)) { setState({ status: "ready", data: npLyricsCache.get(uri) }); return undefined; }
    let dead = false;
    setState({ status: "loading", data: null });
    (async () => {
      let data = null;
      try { data = await npFetchSpotifyLyrics(track); } catch (e) { /* try next source */ }
      if (!data) { try { data = await npFetchLrclib(track); } catch (e) { /* none */ } }
      if (dead) return;
      if (data) npLyricsCache.set(uri, data);
      setState(data ? { status: "ready", data } : { status: "none", data: null });
    })();
    return () => { dead = true; };
  }, [uri, enabled]);

  return state;
}

function NpLyrics({ state }) {
  const boxRef = npUseRef(null);
  const lineRefs = npUseRef([]);
  const holdUntil = npUseRef(0);
  const [active, setActive] = npUseState(-1);
  const data = state.data;
  const synced = !!(data && data.synced);

  /* Which line is current? Checked a few times a second; state only changes per line. */
  npUseEffect(() => {
    if (!synced) { setActive(-1); return undefined; }
    const lines = data.lines;
    const tick = () => {
      const pos = Spicetify.Player.getProgress() + 250;   // light on slightly early
      let lo = 0, hi = lines.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lines[mid].t <= pos) { idx = mid; lo = mid + 1; } else hi = mid - 1;
      }
      setActive(idx);
    };
    tick();
    const id = setInterval(tick, 150);
    return () => clearInterval(id);
  }, [data, synced]);

  npUseEffect(() => { if (boxRef.current) boxRef.current.scrollTop = 0; }, [data]);

  /* Keep the current line centered, unless the person is scrolling by hand. */
  npUseEffect(() => {
    const box = boxRef.current, el = lineRefs.current[active];
    if (!box || !el || Date.now() < holdUntil.current) return;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: reduce ? "auto" : "smooth" });
  }, [active]);

  if (state.status === "idle") return null;
  if (state.status === "loading") return h("div", { className: "np-lyrics-note" }, h("p", { className: "np-empty" }, "Finding lyrics…"));
  if (state.status === "none") return h("div", { className: "np-lyrics-note" }, h("p", { className: "np-empty" }, "No lyrics found for this track."));

  const hold = () => { holdUntil.current = Date.now() + 4000; };
  const Tag = synced ? "button" : "p";

  return h("div", { className: "np-lyrics-wrap" },
    h("div", { className: "np-lyrics" + (synced ? " is-synced" : ""), ref: boxRef, tabIndex: 0, "aria-label": "Lyrics", onWheel: hold, onTouchMove: hold, onPointerDown: hold },
      h("div", { className: "np-lyrics-pad" }),
      data.lines.map((l, i) =>
        h(Tag, {
          key: i,
          ref: (el) => { lineRefs.current[i] = el; },
          className: "np-line" + (i === active ? " is-active" : ""),
          "data-d": active < 0 ? 3 : Math.min(Math.abs(i - active), 3),
          onClick: synced && l.t != null ? () => Spicetify.Player.seek(l.t) : undefined,
        }, l.text || "·")),
      h("div", { className: "np-lyrics-pad" })),
    h("p", { className: "np-credit" }, "Lyrics via " + data.source + (synced ? " · click a line to jump" : "")));
}

/* ---------- Page ---------- */

function NowPlaying() {
  const { track, playing, queue } = useNowPlaying();
  const [mode, setMode] = npUseState(() => npLoad(NP_KEYS.mode, ["next", "recent", "hidden"], "next"));
  const [waveMode, setWaveMode] = npUseState(() => npLoad(NP_KEYS.wave, NP_WAVES, "waves"));
  const [grain, setGrain] = npUseState(() => npLoad(NP_KEYS.grain, ["on", "off"], "on") === "on");
  const [menuOpen, setMenuOpen] = npUseState(false);
  const menuRef = npUseRef(null);
  const [lyricsOn, setLyricsOn] = npUseState(() => npLoad(NP_KEYS.lyrics, ["on", "off"], "off") === "on");
  const [full, setFull] = npUseState(false);
  const [uiHidden, setUiHidden] = npUseState(false);

  const chooseMode = (m) => { setMode(m); npSave(NP_KEYS.mode, m); };
  const toggleLyrics = () => { setLyricsOn((v) => { npSave(NP_KEYS.lyrics, v ? "off" : "on"); return !v; }); };
  const lyr = useLyrics(track, lyricsOn);
  const chooseWave = (m) => { setWaveMode(m); npSave(NP_KEYS.wave, m); };
  const toggleGrain = () => { setGrain((g) => { npSave(NP_KEYS.grain, g ? "off" : "on"); return !g; }); };

  /* Background menu: closes on outside click or Esc. */
  npUseEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  /* Fill-window mode: Esc leaves; toolbar and cursor fade after 3s of stillness. */
  npUseEffect(() => {
    if (!full) { setUiHidden(false); return undefined; }
    let timer;
    const wake = () => {
      setUiHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => setUiHidden(true), 3000);
    };
    const onKey = (e) => { if (e.key === "Escape") setFull(false); wake(); };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", onKey);
    };
  }, [full]);

  const tabs = [["next", "Up next"], ["recent", "Recent"], ["hidden", "Hide"]];

  const toolbar = h("div", { className: "np-toolbar" },
    h("button", {
      className: "np-tool" + (lyricsOn ? " is-on" : ""), "aria-pressed": lyricsOn,
      title: lyricsOn ? "Hide lyrics" : "Show lyrics", onClick: toggleLyrics,
    }, npStroke(NP_PATHS.lines)),
    h("div", { className: "np-menu-anchor", ref: menuRef },
      h("button", {
        className: "np-tool" + (waveMode !== "off" ? " is-on" : ""), "aria-haspopup": "menu", "aria-expanded": menuOpen,
        title: "Background", onClick: () => setMenuOpen((o) => !o),
      }, npStroke(NP_PATHS.wave)),
      menuOpen ? h("div", { className: "np-menu", role: "menu", "aria-label": "Background" },
        h("p", { className: "np-menu-label" }, "Background"),
        NP_WAVES.map((id) =>
          h("button", {
            key: id, role: "menuitemradio", "aria-checked": waveMode === id,
            className: "np-menu-item" + (waveMode === id ? " is-checked" : ""), onClick: () => chooseWave(id),
          }, h("span", { className: "np-mark" }), NP_WAVE_LABELS[id])),
        h("div", { className: "np-menu-sep" }),
        h("button", {
          role: "menuitemcheckbox", "aria-checked": grain,
          className: "np-menu-item" + (grain ? " is-checked" : ""), onClick: toggleGrain,
        }, h("span", { className: "np-mark" }), "Grain")) : null),
    h("button", {
      className: "np-tool", "aria-pressed": full,
      title: full ? "Exit full window (Esc)" : "Fill the window", onClick: () => setFull((f) => !f),
    }, npStroke(full ? NP_PATHS.shrink : NP_PATHS.expand)));

  const content = !track
    ? h("p", { className: "np-empty" }, "Nothing playing. Start a song and it will show up here.")
    : [
      h("div", { className: "np-track", key: track.uri },
        h("div", { className: "np-cover" }, track.cover ? h("img", { src: track.cover, alt: "" }) : null),
        h("div", { className: "np-meta" },
          h("h1", { className: "np-title" }, track.title),
          h("p", { className: "np-artist" }, track.artist),
          track.album ? h("p", { className: "np-album" }, track.album) : null)),
      lyricsOn ? h(NpLyrics, { key: "lyrics", state: lyr }) : null,
      h(NpProgress, { key: "progress" }),
      h("div", { className: "np-controls", key: "controls" },
        h("div", { className: "np-controls-side" }, h(NpModes)),
        h("div", { className: "np-controls-mid" },
          h("button", { className: "np-btn", onClick: () => Spicetify.Player.back(), "aria-label": "Previous" }, npIcon(NP_PATHS.prev, "Previous")),
          h("button", { className: "np-btn np-btn-main", onClick: () => Spicetify.Player.togglePlay(), "aria-label": playing ? "Pause" : "Play" }, npIcon(playing ? NP_PATHS.pause : NP_PATHS.play, playing ? "Pause" : "Play")),
          h("button", { className: "np-btn", onClick: () => Spicetify.Player.next(), "aria-label": "Next" }, npIcon(NP_PATHS.next, "Next"))),
        h("div", { className: "np-controls-side np-controls-end" }, h(NpVolume))),
      lyricsOn ? null : h("div", { className: "np-tabs", role: "group", "aria-label": "Queue view", key: "tabs" },
        tabs.map(([id, label]) =>
          h("button", { key: id, className: "np-tab" + (mode === id ? " is-active" : ""), "aria-pressed": mode === id, onClick: () => chooseMode(id) }, label))),
      !lyricsOn && mode === "next" ? h(NpList, { key: "next", items: queue.next, empty: "Nothing queued after this." }) : null,
      !lyricsOn && mode === "recent" ? h(NpList, { key: "recent", items: queue.prev, empty: "Nothing played before this yet." }) : null,
    ];

  const page = h("div", {
    className: "np-root" + (full ? " is-full" : "") + (uiHidden ? " ui-hidden" : "") + (lyricsOn ? " has-lyrics" : "") + (grain ? " has-grain" : "") + (track ? "" : " is-empty"),
  },
    track ? h("div", { className: "np-ambient", style: track.cover ? { backgroundImage: "url(" + track.cover + ")" } : null, "aria-hidden": true }) : null,
    waveMode !== "off" && track ? h(NpWave, { track, playing, waveStyle: waveMode }) : null,
    toolbar,
    h("div", { className: "np-stage" }, content));

  /* In fill-window mode the page moves to <body> so it can cover Spotify's own chrome. */
  return full ? Spicetify.ReactDOM.createPortal(page, document.body) : page;
}

function render() {
  return h(NowPlaying);
}
