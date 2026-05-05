import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { existsSync, unlinkSync, statSync, createReadStream, writeFileSync, readFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";
import { randomUUID } from "crypto";
import multer from "multer";

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 9032;
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_TIMEOUT_MS = 8 * 60 * 1000;

// Cookies file location (persistent)
const COOKIES_DIR = join(homedir(), ".config", "fight-breaker");
const COOKIES_PATH = join(COOKIES_DIR, "cookies.txt");
try { mkdirSync(COOKIES_DIR, { recursive: true }); } catch (_) {}

// In-memory job store
const jobs = new Map();

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      try { if (job.proc) job.proc.kill(); } catch (_) {}
      try { if (job.file && existsSync(job.file)) unlinkSync(job.file); } catch (_) {}
      jobs.delete(id);
    }
  }
}, 2 * 60 * 1000);

const YT_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)/;

// Build base yt-dlp args (js-runtime + cookies if available)
function ytdlpBase() {
  const args = [
    "--js-runtime", "node",
    "--remote-components", "ejs:github",
    // bgutil removed — not needed on hosted deployment
  ];
  if (existsSync(COOKIES_PATH)) {
    args.push("--cookies", COOKIES_PATH);
  }
  return args;
}

// For non-YouTube sites: impersonate a real browser to bypass Cloudflare / bot checks
function universalBase() {
  const args = ["--impersonate", "", "--extractor-args", "generic:impersonate"];
  if (existsSync(COOKIES_PATH)) {
    args.push("--cookies", COOKIES_PATH);
  }
  return args;
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", [...ytdlpBase(), ...args]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.slice(-1200) || `exit ${code}`));
    });
  });
}

function buildStoryboard(info) {
  const sbs = (info.formats || []).filter(f => f.ext === "mhtml");
  const sb = sbs.find(s => s.format_id === "sb1") || sbs.find(s => s.format_id === "sb2") || sbs[0];
  if (!sb || !sb.fragments?.length) return null;
  const [tw, th] = (sb.resolution || "160x90").split("x").map(Number);
  return {
    tile_w: tw || 160,
    tile_h: th || 90,
    cols: sb.columns || 5,
    rows: sb.rows || 5,
    fps: sb.fps || 0.5,
    fragments: sb.fragments.map(f => ({ url: f.url, duration: f.duration })),
  };
}

function secToHMS(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
    : `${m}:${String(s).padStart(2,"0")}`;
}

// ── /node-api/cookies-status ──────────────────────────────────────────────────
app.get("/node-api/cookies-status", (req, res) => {
  const has = existsSync(COOKIES_PATH);
  let size = 0;
  if (has) { try { size = statSync(COOKIES_PATH).size; } catch (_) {} }
  res.json({ has, size });
});

// ── /node-api/upload-cookies ─────────────────────────────────────────────────
const cookiesUpload = multer({ dest: tmpdir() });
app.post("/node-api/upload-cookies", cookiesUpload.single("cookies"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const content = readFileSync(req.file.path, "utf8");
    if (!content.includes("youtube.com") && !content.includes("Netscape")) {
      try { unlinkSync(req.file.path); } catch (_) {}
      return res.status(400).json({ error: "Doesn't look like a YouTube cookies file" });
    }
    writeFileSync(COOKIES_PATH, content);
    try { unlinkSync(req.file.path); } catch (_) {}
    res.json({ ok: true, size: content.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /node-api/delete-cookies ──────────────────────────────────────────────────
app.delete("/node-api/delete-cookies", (req, res) => {
  try { if (existsSync(COOKIES_PATH)) unlinkSync(COOKIES_PATH); } catch (_) {}
  res.json({ ok: true });
});

// ── /node-api/info ────────────────────────────────────────────────────────────

app.get("/node-api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL is required" });
  if (!YT_REGEX.test(url)) return res.status(400).json({ error: "Please enter a valid YouTube URL" });

  try {
    const raw = await new Promise((resolve, reject) => {
      const proc = spawn("yt-dlp", [...universalBase(), "--dump-json", "--no-playlist", url]);
      let out = "", err = "";
      proc.stdout.on("data", d => { out += d; });
      proc.stderr.on("data", d => { err += d; });
      proc.on("close", code => code === 0 ? resolve(out) : reject(new Error(err || out)));
    });
    const info = JSON.parse(raw);
    const formats = [];

    for (const f of info.formats || []) {
      if (!f.url) continue;
      const hasVideo = f.vcodec && f.vcodec !== "none";
      const hasAudio = f.acodec && f.acodec !== "none";

      if (hasVideo) {
        const h = f.height || 0;
        const vcodec = (f.vcodec || "").toLowerCase();
        let codecFamily = "h264";
        if (vcodec.includes("av01") || vcodec.includes("av1")) codecFamily = "av1";
        else if (vcodec.includes("vp9") || vcodec.includes("vp09")) codecFamily = "vp9";

        formats.push({
          format_id: f.format_id,
          label: h ? `${h}p` : f.format_note || f.format_id,
          ext: f.ext || "mp4",
          type: "video",
          resolution: f.resolution || (h ? `${f.width || "?"}x${h}` : null),
          height: h,
          width: f.width || 0,
          fps: f.fps || null,
          filesize: f.filesize || f.filesize_approx || null,
          vcodec: f.vcodec || null,
          acodec: f.acodec || null,
          codec_family: codecFamily,
          has_audio: hasAudio,
          tbr: f.tbr || null,
          format_note: f.format_note || null,
          abr: f.abr || null,
        });
      } else if (hasAudio && !hasVideo) {
        formats.push({
          format_id: f.format_id,
          label: f.format_note || (f.abr ? `${f.abr}kbps` : f.format_id),
          ext: f.ext || "m4a",
          type: "audio",
          resolution: null,
          height: 0,
          fps: null,
          filesize: f.filesize || f.filesize_approx || null,
          vcodec: null,
          acodec: f.acodec || null,
          codec_family: "audio",
          has_audio: true,
          tbr: f.tbr || null,
          format_note: f.format_note || null,
          abr: f.abr || null,
        });
      }
    }

    const videoFormats = formats.filter((f) => f.type === "video").sort((a, b) => b.height - a.height);
    const audioFormats = formats.filter((f) => f.type === "audio");

    const bestAacAudio = (info.formats || [])
      .filter(f => f.acodec && f.acodec.includes("mp4a") && (!f.vcodec || f.vcodec === "none"))
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

    const h264Formats = videoFormats.filter(f => f.codec_family === "h264");
    const editorHqFormat = h264Formats[0] || videoFormats[0] || null;

    const chapters = (info.chapters || []).map(ch => ({
      title: ch.title,
      start_time: ch.start_time,
      end_time: ch.end_time,
      start_label: secToHMS(ch.start_time),
      end_label: secToHMS(ch.end_time),
    }));

    const subtitles = Object.entries(info.subtitles || {}).map(([lang, fmts]) => ({
      lang,
      name: fmts[0]?.name || lang,
    }));

    const autoSubs = Object.entries(info.automatic_captions || {})
      .filter(([lang]) => lang === "en" || lang.startsWith("en-"))
      .slice(0, 3)
      .map(([lang, fmts]) => ({
        lang,
        name: `${fmts[0]?.name || lang} (auto)`,
        auto: true,
      }));

    res.json({
      id: info.id,
      title: info.title,
      thumbnail: info.thumbnail,
      duration: info.duration,
      duration_string: info.duration_string,
      uploader: info.uploader,
      view_count: info.view_count,
      best_aac_audio_id: bestAacAudio?.format_id || "140",
      editor_hq_format_id: editorHqFormat?.format_id || null,
      chapters,
      subtitles: [...subtitles, ...autoSubs],
      storyboard: buildStoryboard(info),
      formats: [...videoFormats, ...audioFormats],
    });
  } catch (err) {
    // Friendlier error messages
    const msg = err.message || "";
    let friendly = "Failed to fetch info. ";
    if (msg.includes("Sign in to confirm") || msg.includes("bot")) {
      friendly = "Could not fetch video info — please try again.";
    } else if (msg.includes("Private video")) {
      friendly = "This video is private.";
    } else if (msg.includes("Video unavailable")) {
      friendly = "Video unavailable or deleted.";
    } else {
      friendly += msg.slice(0, 300);
    }
    res.status(500).json({ error: friendly });
  }
});

// ── /node-api/stream-url ──────────────────────────────────────────────────────

app.get("/node-api/stream-url", async (req, res) => {
  const { url, format_id } = req.query;
  if (!url || !format_id) return res.status(400).json({ error: "url and format_id required" });

  try {
    const raw = await runYtDlp(["--get-url", "-f", format_id, "--no-playlist", url]);
    const urls = raw.split("\n").filter(Boolean);
    res.json({ urls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /node-api/subtitle ────────────────────────────────────────────────────────

app.get("/node-api/subtitle", async (req, res) => {
  const { url, lang, auto } = req.query;
  if (!url || !lang) return res.status(400).json({ error: "url and lang required" });

  const jobId = randomUUID();
  const outBase = join(tmpdir(), `fb_sub_${jobId}`);
  const subsFlag = auto === "1" ? "--write-auto-subs" : "--write-subs";

  try {
    await runYtDlp([
      subsFlag,
      "--sub-langs", lang,
      "--sub-format", "srt",
      "--skip-download",
      "-o", outBase,
      "--no-playlist",
      url,
    ]);

    const dir = tmpdir();
    const files = readdirSync(dir).filter(f => f.startsWith(`fb_sub_${jobId}`) && f.endsWith(".srt"));

    if (files.length === 0) return res.status(404).json({ error: "No subtitle file generated" });

    const filePath = join(dir, files[0]);
    const stat = statSync(filePath);
    res.setHeader("Content-Disposition", `attachment; filename="subtitles.${lang}.srt"`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Length", stat.size);

    const stream = createReadStream(filePath);
    stream.pipe(res);
    stream.on("close", () => { try { unlinkSync(filePath); } catch (_) {} });
  } catch (err) {
    res.status(500).json({ error: "Subtitle download failed: " + err.message });
  }
});

// ── /node-api/start-download ──────────────────────────────────────────────────

app.post("/node-api/start-download", (req, res) => {
  const {
    url,
    format_id,
    title = "video",
    ext = "mp4",
    audio_only,
    codec_family = "h264",
    best_aac_audio_id = "140",
    trim_start,
    trim_end,
  } = req.body;

  if (!url || !format_id) return res.status(400).json({ error: "url and format_id required" });

  const jobId = randomUUID();
  const isAudio = audio_only === true || audio_only === "1" || audio_only === 1;
  const hasTrim = (trim_start != null || trim_end != null);
  const outExt = isAudio ? "mp3" : "mp4";
  const safeTitle = (title || "video").replace(/[^\w\s\-_.()]/g, "").trim().slice(0, 100) || "video";
  const outFile = join(tmpdir(), `fb_${jobId}.${outExt}`);

  jobs.set(jobId, {
    status: "pending",
    phase: "starting",
    progress: 0,
    overall: 0,
    speed: "",
    eta: "",
    file: outFile,
    ext: outExt,
    filename: `${safeTitle}${hasTrim ? "_clip" : ""}.${outExt}`,
    error: null,
    proc: null,
    createdAt: Date.now(),
  });

  let args;

  if (isAudio) {
    args = [
      "-f", format_id,
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "--newline", "--progress",
      "-o", outFile,
      "--no-playlist",
    ];
  } else {
    const isVP9orAV1 = codec_family === "vp9" || codec_family === "av1";
    const audioSel = `${best_aac_audio_id}/bestaudio[ext=m4a]/bestaudio`;

    args = [
      "-f", `${format_id}+${audioSel}`,
      "--merge-output-format", "mp4",
      "--postprocessor-args", isVP9orAV1
        ? "ffmpeg:-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -movflags +faststart"
        : "ffmpeg:-c:v copy -c:a aac -b:a 192k -movflags +faststart",
      "--newline", "--progress",
      "-o", outFile,
      "--no-playlist",
    ];
  }

  if (hasTrim) {
    const start = trim_start != null ? trim_start : 0;
    const end = trim_end != null ? trim_end : 9999999;
    args.push("--download-sections", `*${start}-${end}`);
    args.push("--force-keyframes-at-cuts");
  }

  args.push(url);

  const proc = spawn("yt-dlp", [...ytdlpBase(), ...args]);
  const job = jobs.get(jobId);
  job.proc = proc;
  job.status = "downloading";
  job.phase = "downloading_video";

  let dlPhase = 0;
  const progressRe = /\[download\]\s+([\d.]+)%\s+of\s+[\d.]+\S+\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/;
  const progressSimple = /\[download\]\s+([\d.]+)%/;
  const destinationRe = /\[download\] Destination:/;
  const mergerRe = /\[Merger\]|\[ffmpeg\]/;

  function parseLine(line) {
    if (destinationRe.test(line)) {
      dlPhase = dlPhase === 0 ? 1 : 2;
      job.phase = dlPhase === 1 ? "downloading_video" : "downloading_audio";
      job.progress = 0;
      return;
    }
    if (mergerRe.test(line)) {
      dlPhase = 3;
      job.phase = "encoding";
      job.overall = 88;
      job.speed = "";
      job.eta = "";
      return;
    }
    const m = line.match(progressRe);
    if (m) {
      const pct = parseFloat(m[1]);
      job.progress = pct;
      job.speed = m[2];
      job.eta = m[3];
      if (dlPhase <= 1) job.overall = Math.round(pct * 0.65);
      else if (dlPhase === 2) job.overall = Math.round(65 + pct * 0.2);
      return;
    }
    const m2 = line.match(progressSimple);
    if (m2) {
      const pct = parseFloat(m2[1]);
      job.progress = pct;
      if (dlPhase <= 1) job.overall = Math.round(pct * 0.65);
      else if (dlPhase === 2) job.overall = Math.round(65 + pct * 0.2);
    }
  }

  proc.stdout.on("data", (chunk) => chunk.toString().split("\n").forEach(parseLine));
  proc.stderr.on("data", (chunk) => chunk.toString().split("\n").forEach(parseLine));

  const timeout = setTimeout(() => {
    try { proc.kill(); } catch (_) {}
    job.status = "error";
    job.error = "Download timed out after 8 minutes";
  }, JOB_TIMEOUT_MS);

  proc.on("close", (code) => {
    clearTimeout(timeout);
    job.proc = null;
    if (code === 0) { job.status = "done"; job.progress = 100; job.overall = 100; job.phase = "done"; }
    else if (job.status !== "error") { job.status = "error"; job.error = `Process exited with code ${code}`; }
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    job.proc = null;
    job.status = "error";
    job.error = err.message;
  });

  res.json({ jobId });
});

// ── /node-api/job/:jobId ──────────────────────────────────────────────────────

app.get("/node-api/job/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    overall: job.overall,
    speed: job.speed,
    eta: job.eta,
    error: job.error,
    filename: job.filename,
  });
});

// ── /node-api/download-file/:jobId ───────────────────────────────────────────

app.get("/node-api/download-file/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (job.status !== "done") return res.status(400).json({ error: "Not ready yet" });
  if (!existsSync(job.file)) return res.status(404).json({ error: "File missing on disk" });

  const stat = statSync(job.file);
  const mimeType = job.ext === "mp3" ? "audio/mpeg" : "video/mp4";

  res.setHeader("Content-Disposition", `attachment; filename="${job.filename}"`);
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", stat.size);

  const stream = createReadStream(job.file);
  stream.pipe(res);
  stream.on("close", () => {
    setTimeout(() => {
      try { unlinkSync(job.file); } catch (_) {}
      jobs.delete(req.params.jobId);
    }, 60_000);
  });
});

// ── /node-api/concat-clips ────────────────────────────────────────────────────

app.post("/node-api/concat-clips", async (req, res) => {
  const { jobIds, title } = req.body;
  if (!Array.isArray(jobIds) || jobIds.length < 2) return res.status(400).json({ error: "Need at least 2 jobIds" });

  for (const jid of jobIds) {
    const j = jobs.get(jid);
    if (!j) return res.status(400).json({ error: `Job ${jid} not found` });
    if (j.status !== "done") return res.status(400).json({ error: `Job ${jid} not done yet` });
    if (!existsSync(j.file)) return res.status(400).json({ error: `File for job ${jid} missing` });
  }

  const concatJobId = randomUUID();
  const safeTitle = (title || "video").replace(/[^\w\s\-_.()]/g, "").trim().slice(0, 100) || "video";
  const outFile = join(tmpdir(), `fb_${concatJobId}.mp4`);
  const listFile = join(tmpdir(), `fb_concat_${concatJobId}.txt`);

  const listContent = jobIds.map(jid => `file '${jobs.get(jid).file}'`).join("\n");
  writeFileSync(listFile, listContent);

  jobs.set(concatJobId, {
    status: "downloading",
    phase: "encoding",
    progress: 0,
    overall: 50,
    speed: "",
    eta: "",
    file: outFile,
    ext: "mp4",
    filename: `${safeTitle}_merged.mp4`,
    error: null,
    proc: null,
    createdAt: Date.now(),
  });

  const ffArgs = [
    "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-fflags", "+genpts",
    "-c", "copy",
    "-movflags", "+faststart",
    outFile
  ];

  const proc = spawn("ffmpeg", ffArgs);
  const job = jobs.get(concatJobId);
  job.proc = proc;

  proc.on("close", (code) => {
    job.proc = null;
    try { unlinkSync(listFile); } catch (_) {}
    if (code === 0) { job.status = "done"; job.progress = 100; job.overall = 100; job.phase = "done"; }
    else if (job.status !== "error") { job.status = "error"; job.error = `ffmpeg concat failed (code ${code})`; }
  });

  proc.on("error", (err) => {
    job.proc = null;
    job.status = "error"; job.error = err.message;
  });

  res.json({ jobId: concatJobId });
});

// ── /node-api/universal-info ──────────────────────────────────────────────────

app.get("/node-api/universal-info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    const raw = await new Promise((resolve, reject) => {
      const proc = spawn("yt-dlp", [...universalBase(), "--dump-json", "--no-playlist", url]);
      let out = "", err = "";
      proc.stdout.on("data", d => { out += d; });
      proc.stderr.on("data", d => { err += d; });
      proc.on("close", code => code === 0 ? resolve(out) : reject(new Error(err || out)));
    });
    const info = JSON.parse(raw);

    res.json({
      title: info.title || info.id || "Untitled",
      thumbnail: info.thumbnail || "",
      url: info.webpage_url || url,
      extractor: info.extractor || info.ie_key || "unknown",
      duration_string: info.duration_string || (info.duration ? secToHMS(info.duration) : null),
      uploader: info.uploader || info.channel || info.creator || null,
    });
  } catch (err) {
    const msg = err.message || "";
    let friendly = "Failed to fetch info.";
    if (msg.includes("Unsupported URL") || msg.includes("No suitable")) {
      friendly = "This URL is not supported by yt-dlp.";
    } else if (msg.includes("Private") || msg.includes("private")) {
      friendly = "This content is private.";
    } else if (msg.includes("login") || msg.includes("Login")) {
      friendly = "This content requires login.";
    } else {
      friendly = msg.slice(0, 300);
    }
    res.status(500).json({ error: friendly });
  }
});

// ── /node-api/universal-download ─────────────────────────────────────────────

app.post("/node-api/universal-download", (req, res) => {
  const { url, preset = "best-video", title = "download" } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const jobId = randomUUID();
  const isAudio = preset === "best-audio-mp3" || preset === "best-audio-m4a";
  const outExt = preset === "best-audio-mp3" ? "mp3" : preset === "best-audio-m4a" ? "m4a" : "mp4";
  const safeTitle = (title || "download").replace(/[^\w\s\-_.()]/g, "").trim().slice(0, 100) || "download";
  const outFile = join(tmpdir(), `fb_${jobId}.${outExt}`);

  jobs.set(jobId, {
    status: "pending",
    phase: "starting",
    progress: 0,
    overall: 0,
    speed: "",
    eta: "",
    file: outFile,
    ext: outExt,
    filename: `${safeTitle}.${outExt}`,
    error: null,
    proc: null,
    createdAt: Date.now(),
  });

  let args;

  if (preset === "best-audio-mp3") {
    args = [
      "-f", "bestaudio",
      "-x", "--audio-format", "mp3", "--audio-quality", "0",
      "--newline", "--progress",
      "-o", outFile,
      "--no-playlist",
      url,
    ];
  } else if (preset === "best-audio-m4a") {
    args = [
      "-f", "bestaudio[ext=m4a]/bestaudio",
      "--newline", "--progress",
      "-o", outFile,
      "--no-playlist",
      url,
    ];
  } else {
    // best-video: best video + best audio, mux to mp4
    args = [
      "-f", "bestvideo+bestaudio/best",
      "--merge-output-format", "mp4",
      "--postprocessor-args", "ffmpeg:-c:v copy -c:a aac -b:a 192k -movflags +faststart",
      "--newline", "--progress",
      "-o", outFile,
      "--no-playlist",
      url,
    ];
  }

  const proc = spawn("yt-dlp", [...universalBase(), ...args]);
  const job = jobs.get(jobId);
  job.proc = proc;
  job.status = "downloading";
  job.phase = "downloading";

  const progressRe = /\[download\]\s+([\d.]+)%\s+of\s+[\d.]+\S+\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/;
  const progressSimple = /\[download\]\s+([\d.]+)%/;
  const mergerRe = /\[Merger\]|\[ffmpeg\]|\[ExtractAudio\]/;

  let dlPhase = 0;
  function parseLine(line) {
    if (line.includes("[download] Destination:")) {
      dlPhase++;
      job.phase = dlPhase <= 1 ? "downloading_video" : "downloading_audio";
      job.progress = 0;
      return;
    }
    if (mergerRe.test(line)) {
      job.phase = "encoding";
      job.overall = 88;
      return;
    }
    const m = line.match(progressRe);
    if (m) {
      const pct = parseFloat(m[1]);
      job.progress = pct;
      job.speed = m[2];
      job.eta = m[3];
      job.overall = dlPhase <= 1 ? Math.round(pct * 0.65) : Math.round(65 + pct * 0.2);
      return;
    }
    const m2 = line.match(progressSimple);
    if (m2) {
      const pct = parseFloat(m2[1]);
      job.progress = pct;
      job.overall = dlPhase <= 1 ? Math.round(pct * 0.65) : Math.round(65 + pct * 0.2);
    }
  }

  proc.stdout.on("data", (chunk) => chunk.toString().split("\n").forEach(parseLine));
  proc.stderr.on("data", (chunk) => chunk.toString().split("\n").forEach(parseLine));

  const timeout = setTimeout(() => {
    try { proc.kill(); } catch (_) {}
    job.status = "error";
    job.error = "Download timed out after 8 minutes";
  }, JOB_TIMEOUT_MS);

  proc.on("close", (code) => {
    clearTimeout(timeout);
    job.proc = null;
    if (code === 0) { job.status = "done"; job.progress = 100; job.overall = 100; job.phase = "done"; }
    else if (job.status !== "error") { job.status = "error"; job.error = `Process exited with code ${code}`; }
  });

  proc.on("error", (err) => {
    clearTimeout(timeout);
    job.proc = null;
    job.status = "error";
    job.error = err.message;
  });

  res.json({ jobId });
});

// ── Serve frontend static files ───────────────────────────────────────────────
import { fileURLToPath } from "url";
const __dirname = fileURLToPath(new URL(".", import.meta.url));
app.use(express.static(join(__dirname, "public")));
app.get("/{*splat}", (req, res) => {
  res.sendFile(join(__dirname, "public", "index.html"));
});

const PORT_NUM = parseInt(process.env.PORT || String(PORT), 10);
app.listen(PORT_NUM, "0.0.0.0", () => console.log(`[fight-breaker] http://0.0.0.0:${PORT_NUM}`));
