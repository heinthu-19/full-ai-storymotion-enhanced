import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpegPath from "ffmpeg-static";
const execFileAsync = promisify(execFile);
import { fileURLToPath } from "node:url";
import * as googleTTS from "google-tts-api";

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: "25mb" }));
app.use(express.static(path.join(__dirname, "public")));

const hasGemini = () => Boolean(process.env.GEMINI_API_KEY);
const hasCloudflare = () => Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
const hasBurmeseVoice = () => true;
const hasVideo = () => Boolean(process.env.REPLICATE_API_TOKEN);
const videoJobs = new Map(); // Google Translate TTS (my) requires no API key; availability may vary.

function httpError(message, status = 500) {
  const err = new Error(message);
  err.status = status;
  return err;
}
function friendlyError(err) {
  const status = Number.isInteger(err.status) ? err.status : 500;
  let message = err.message || "မသိရှိသော server error ဖြစ်နေပါသည်။";
  if (status === 401 || status === 403) message = "API Key မမှန်ခြင်း သို့မဟုတ် ဝန်ဆောင်မှုခွင့်ပြုချက် မရှိခြင်း ဖြစ်နိုင်ပါတယ်။ Render Environment မှာ Key နဲ့ Region ကို စစ်ပါ။";
  else if (status === 429) message = "Free tier သုံးစွဲမှုကန့်သတ်ချက် ပြည့်သွားနိုင်ပါတယ်။ ခဏစောင့်ပြီး ထပ်စမ်းပါ။";
  else if (status >= 500 && !err.message) message = "Server မှာ အမှားဖြစ်နေပါတယ်။ Render Logs ကို စစ်ပါ။";
  return { status, message };
}
async function fetchJson(url, options = {}, serviceName = "API") {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || `${serviceName} request failed (${response.status})`;
    throw httpError(detail, response.status);
  }
  return data;
}

app.get("/api/health", (_req, res) => res.json({
  ok: true,
  configured: hasGemini(),
  services: { story: hasGemini(), image: hasCloudflare(), voice: hasBurmeseVoice(), video: hasVideo() },
  providers: { story: "Gemini API (legacy mode)", image: "Cloudflare Workers AI FLUX.1 schnell", voice: "Google Translate TTS Burmese (single voice; best-effort)", video: "Replicate minimax/video-01 (6-second clips; paid API)" }
}));

app.post("/api/story", async (req, res) => {
  try {
    const { idea, genre = "Fantasy", minutes = 5, style = "2.5D Cinematic Fantasy", language = "Myanmar" } = req.body || {};
    if (!idea || typeof idea !== "string" || idea.trim().length < 3) return res.status(400).json({ error: "ဝတ္ထုအကြောင်းအရာ အနည်းဆုံး စာလုံးအနည်းငယ် ထည့်ပါ။" });
    if (!hasGemini()) throw httpError("Render Environment မှာ GEMINI_API_KEY မထည့်ရသေးပါ။ Google AI Studio မှာ API key ဖန်တီးပါ။", 400);
    const safeMinutes = Math.min(30, Math.max(3, Number(minutes) || 5));
    const sceneMin = Math.min(24, Math.max(4, safeMinutes * 2));
    const sceneMax = Math.min(36, Math.max(6, safeMinutes * 3));
    const prompt = `You are a professional story writer and animation storyboard artist. Write in ${language === "Myanmar" ? "natural, fluent Burmese language using Myanmar script (မြန်မာဘာသာ)" : "English"}. Create an original ${genre} story based on this idea: ${idea.trim()}. Target narration duration: about ${safeMinutes} minutes. Split into scenes suitable for 2.5D parallax animation. Visual style: ${style}. Return ONLY valid JSON matching this schema: {"title":"...","logline":"...","story":"full narration text","characters":[{"name":"...","description":"consistent visual description"}],"scenes":[{"title":"...","narration":"spoken narration for this scene in natural Burmese","visual_prompt":"English image-generation prompt, one cinematic frame, layered foreground/midground/background, no text, consistent character design","camera":"slow push-in or slow pan left or slow pan right"}]}. Create approximately ${sceneMin} to ${sceneMax} scenes. Make narration substantial enough for the target duration. Do not include markdown fences.`;
    const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(process.env.GEMINI_MODEL || "gemini-2.5-flash")}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.8 } })
    }, "Gemini API");
    let raw = data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
    raw = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const first = raw.indexOf("{"), last = raw.lastIndexOf("}");
    if (first < 0 || last <= first) throw httpError("Gemini က JSON format မပြန်ပေးခဲ့ပါ။ ထပ်စမ်းပါ။", 502);
    const story = JSON.parse(raw.slice(first, last + 1));
    if (!Array.isArray(story.scenes) || !story.scenes.length) throw httpError("AI output မှာ scenes မပါဝင်ပါ။ ထပ်စမ်းပါ။", 502);
    story.scenes = story.scenes.map((s, i) => {
      const cameraText = String(s.camera || "slow push-in").toLowerCase();
      const motionMode = cameraText.includes("pan left") ? "panleft" : cameraText.includes("pan right") ? "panright" : cameraText.includes("pull") || cameraText.includes("zoom out") ? "pull" : cameraText.includes("drift") || cameraText.includes("float") ? "drift" : cameraText.includes("parallax") ? "parallax" : "push";
      return {
        id: i + 1, title: String(s.title || `Scene ${i + 1}`), narration: String(s.narration || ""),
        visual_prompt: String(s.visual_prompt || `${style}, cinematic story illustration`),
        camera: cameraText, motionMode, durationSeconds: 8,
        image: null, audio: null, backgroundLayer: null, midgroundLayer: null, foregroundLayer: null
      };
    });
    res.json(story);
  } catch (err) {
    const e = friendlyError(err); res.status(e.status).json({ error: e.message });
  }
});

app.post("/api/image", async (req, res) => {
  try {
    const { prompt, style = "2.5D Cinematic Fantasy", ratio = "16:9" } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "Image prompt မရှိပါ။" });
    if (!hasCloudflare()) throw httpError("Render Environment မှာ CLOUDFLARE_ACCOUNT_ID နဲ့ CLOUDFLARE_API_TOKEN ထည့်ပါ။ Cloudflare Workers AI Free allocation ကို အသုံးပြုနိုင်ပါတယ်။", 400);
    const ratioHint = ratio === "9:16" ? "vertical portrait 9:16 composition" : ratio === "1:1" ? "square 1:1 composition" : "wide landscape 16:9 composition";
    const imagePrompt = `${style}. ${ratioHint}. One polished cinematic 2.5D animation keyframe, clear foreground, midground and background separation for parallax camera movement, beautiful lighting, consistent character design, no letters, no subtitles, no watermark. Scene: ${prompt}`;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
    const result = await fetchJson(url, {
      method: "POST", headers: { "Authorization": `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: imagePrompt, steps: 4 })
    }, "Cloudflare Workers AI");
    if (!result.image) throw httpError("Image API က ပုံမပြန်ပေးခဲ့ပါ။ Cloudflare Workers AI quota နဲ့ model access ကို စစ်ပါ။", 502);
    res.json({ image: `data:image/png;base64,${result.image}` });
  } catch (err) {
    const e = friendlyError(err); res.status(e.status).json({ error: e.message });
  }
});

app.post("/api/voice", async (req, res) => {
  try {
    const { text, voice = "female" } = req.body || {};
    if (!text || typeof text !== "string") return res.status(400).json({ error: "Voice အတွက် စာသားမရှိပါ။" });
    if (text.length > 8000) return res.status(400).json({ error: "Scene narration တစ်ခုသည် 8000 characters ထက် မကျော်ရပါ။ Scene ကို ပိုတိုအောင် ခွဲပါ။" });
    // Google Translate TTS supports Burmese (my) and needs no API key.
    // This is an unofficial, best-effort endpoint, so rate limits/availability can change.
    const chunks = googleTTS.getAllAudioUrls(text.trim(), {
      lang: "my", slow: false, host: "https://translate.google.com", splitPunct: "။၊,!?."
    });
    if (!chunks.length) throw httpError("အသံဖန်တီးရန် မြန်မာစာသား မရရှိပါ။", 400);
    const buffers = [];
    for (const chunk of chunks) {
      const response = await fetch(chunk.url, { headers: { "User-Agent": "Mozilla/5.0 Full-AI-StoryMotion" } });
      if (!response.ok) throw httpError(`မြန်မာ TTS ဝန်ဆောင်မှုက အသံမပေးနိုင်ပါ (${response.status})။ ခဏစောင့်ပြီး ထပ်စမ်းပါ။`, 502);
      buffers.push(Buffer.from(await response.arrayBuffer()));
    }
    const audio = Buffer.concat(buffers);
    res.json({ audio: `data:audio/mpeg;base64,${audio.toString("base64")}`, voice: "Google TTS Burmese (my)" });
  } catch (err) {
    const e = friendlyError(err); res.status(e.status).json({ error: e.message });
  }
});

// Prompt-to-Movie: the user's exact prompt is sent as the base prompt. No Gemini/story rewrite is called.
app.post("/api/video", async (req, res) => {
  try {
    const { prompt, shot = 1, totalShots = 50, aspectRatio = "16:9", firstFrameImage = null, subjectReference = null, cameraMove = "none" } = req.body || {};
    if (!hasVideo()) throw httpError("Render Environment မှာ REPLICATE_API_TOKEN ထည့်ပါ။ Replicate API က paid usage ဖြစ်နိုင်ပါတယ်။", 400);
    if (typeof prompt !== "string" || prompt.trim().length < 3) throw httpError("Movie Prompt အနည်းဆုံး စာလုံးအနည်းငယ် ထည့်ပါ။", 400);
    const shotNo = Math.max(1, Math.min(100, Number(shot) || 1));
    const count = Math.max(1, Math.min(100, Number(totalShots) || 50));
    const ratio = aspectRatio === "9:16" ? "vertical portrait 9:16 composition" : aspectRatio === "1:1" ? "square 1:1 composition" : "widescreen 16:9 composition";
    const allowedCameras = new Set(["none", "[Pan left]", "[Pan right]", "[Push in]", "[Pull out]", "[Tracking shot]", "[Static shot]"]);
    const selectedCamera = allowedCameras.has(cameraMove) ? cameraMove : "none";
    const cameraNotes = ["wide establishing shot", "medium cinematic shot", "slow tracking shot", "close-up detail shot", "low-angle cinematic shot", "over-the-shoulder shot"];
    // The user's prompt remains the exact base text. We append production metadata only.
    const shotPrompt = `${prompt.trim()}\n\nProduction metadata: ${ratio}. Shot ${shotNo} of ${count}; ${cameraNotes[(shotNo - 1) % cameraNotes.length]}.${selectedCamera !== "none" ? ` Camera direction: ${selectedCamera}.` : ""} Preserve the people, setting, costume and visual facts specified in the original prompt. Do not invent a new plot or add unrelated characters. No text, captions, logos or watermark.`;
    const input = { prompt: shotPrompt, prompt_optimizer: false };
    const validImageDataUrl = (value, name) => {
      if (value == null || value === "") return null;
      if (typeof value !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) throw httpError(`${name} သည် PNG/JPEG/WebP base64 image ဖြစ်ရပါမယ်။`, 400);
      if (value.length > 1_400_000) throw httpError(`${name} ပုံအရွယ်အစားကြီးနေပါတယ်။ 1MB အောက်ဖြစ်အောင် လျှော့ပါ။`, 413);
      return value;
    };
    const firstFrame = validImageDataUrl(firstFrameImage, "Start frame");
    const subject = validImageDataUrl(subjectReference, "Character reference");
    if (firstFrame) input.first_frame_image = firstFrame;
    if (subject) input.subject_reference = subject;
    const prediction = await fetchJson("https://api.replicate.com/v1/models/minimax/video-01/predictions", {
      method: "POST", headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}`, "Content-Type": "application/json", "Prefer": "wait=1" },
      body: JSON.stringify({ input })
    }, "Replicate Video API");
    if (!prediction.id) throw httpError("Video API က prediction ID မပြန်ပေးခဲ့ပါ။", 502);
    videoJobs.set(prediction.id, { id: prediction.id, shot: shotNo, status: prediction.status || "starting", output: prediction.output || null, error: prediction.error || null });
    res.json({ id: prediction.id, status: prediction.status || "starting", shot: shotNo, output: prediction.output || null, urls: prediction.urls || {} });
  } catch (err) { const e = friendlyError(err); res.status(e.status).json({ error: e.message }); }
});

app.get("/api/video/:id", async (req, res) => {
  try {
    if (!hasVideo()) throw httpError("REPLICATE_API_TOKEN မသတ်မှတ်ရသေးပါ။", 400);
    if (!/^[a-z0-9]+$/i.test(req.params.id)) throw httpError("Prediction ID မမှန်ပါ။", 400);
    const prediction = await fetchJson(`https://api.replicate.com/v1/predictions/${encodeURIComponent(req.params.id)}`, {
      headers: { "Authorization": `Bearer ${process.env.REPLICATE_API_TOKEN}` }
    }, "Replicate Video API");
    res.json({ id: prediction.id, status: prediction.status, output: prediction.output || null, error: prediction.error || null, logs: prediction.logs || "", urls: prediction.urls || {} });
  } catch (err) { const e = friendlyError(err); res.status(e.status).json({ error: e.message }); }
});

// Join completed Replicate clips into one MP4. Only Replicate delivery URLs are accepted.
app.post("/api/movie/assemble", async (req, res) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storymotion-"));
  try {
    const { clips } = req.body || {};
    if (!Array.isArray(clips) || clips.length < 1 || clips.length > 100) throw httpError("Clip 1 မှ 100 ခုအထိ ပေးပါ။", 400);
    const localFiles = [];
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const url = typeof clip === "string" ? clip : clip?.url;
      if (typeof url !== "string") throw httpError(`Clip ${i + 1} URL မမှန်ပါ။`, 400);
      const parsed = new URL(url);
      if (!(["replicate.delivery", "stream.replicate.com"].includes(parsed.hostname) || parsed.hostname.endsWith(".replicate.delivery"))) throw httpError("လုံခြုံရေးအရ Replicate output URL များကိုသာ ပေါင်းနိုင်ပါသည်။", 400);
      const response = await fetch(parsed, { redirect: "follow" });
      if (!response.ok) throw httpError(`Clip ${i + 1} download မအောင်မြင်ပါ (${response.status})။`, 502);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > 150 * 1024 * 1024) throw httpError(`Clip ${i + 1} ဖိုင်အရွယ်အစား မမှန်ပါ။`, 400);
      const file = path.join(tempDir, `clip-${String(i).padStart(3, "0")}.mp4`);
      await fs.writeFile(file, bytes);
      let audioPath = null;
      const audioData = typeof clip === "object" ? clip.audioData : null;
      if (typeof audioData === "string" && /^data:audio\/(mpeg|mp3|wav|wav;|ogg|webm|mp4|aac|x-wav);base64,/i.test(audioData)) {
        const match = audioData.match(/^data:audio\/[^;]+;base64,([\s\S]+)$/i);
        if (match) { audioPath = path.join(tempDir, `voice-${String(i).padStart(3, "0")}.audio`); await fs.writeFile(audioPath, Buffer.from(match[1], "base64")); }
      }
      if (audioPath) {
        const muxed = path.join(tempDir, `muxed-${String(i).padStart(3, "0")}.mp4`);
        await execFileAsync(ffmpegPath, ["-y", "-i", file, "-i", audioPath, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-af", "apad", "-t", "6", "-movflags", "+faststart", muxed], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
        localFiles.push(muxed);
      } else {
        const muxed = path.join(tempDir, `silent-${String(i).padStart(3, "0")}.mp4`);
        await execFileAsync(ffmpegPath, ["-y", "-i", file, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-t", "6", "-shortest", "-movflags", "+faststart", muxed], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
        localFiles.push(muxed);
      }
    }
    const listPath = path.join(tempDir, "clips.txt");
    await fs.writeFile(listPath, localFiles.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
    const outputName = `storymotion-movie-${Date.now()}.mp4`;
    const outputPath = path.join(os.tmpdir(), outputName);
    await execFileAsync(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", outputPath], { timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    res.json({ ok: true, filename: outputName, downloadUrl: `/api/movie/download/${outputName}`, clipCount: clips.length });
  } catch (err) {
    const e = friendlyError(err); res.status(e.status).json({ error: e.message });
  } finally { await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {}); }
});
app.get("/api/movie/download/:filename", async (req, res) => {
  const name = req.params.filename;
  if (!/^storymotion-movie-\d+\.mp4$/.test(name)) return res.status(400).json({ error: "ဖိုင်အမည် မမှန်ပါ။" });
  const file = path.join(os.tmpdir(), name);
  try { await fs.access(file); res.download(file, name, () => fs.rm(file, { force: true }).catch(() => {})); }
  catch { res.status(404).json({ error: "Movie ဖိုင်မရှိတော့ပါ။ ပြန်ပေါင်းထုတ်ပါ။" }); }
});

app.listen(Number(process.env.PORT) || 3000, () => console.log(`StoryMotion running on port ${Number(process.env.PORT) || 3000}`));
