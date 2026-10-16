import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as googleTTS from "google-tts-api";

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const hasGemini = () => Boolean(process.env.GEMINI_API_KEY);
const hasCloudflare = () => Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);
const hasBurmeseVoice = () => true; // Google Translate TTS (my) requires no API key; availability may vary.

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
  services: { story: hasGemini(), image: hasCloudflare(), voice: hasBurmeseVoice() },
  providers: { story: "Gemini API", image: "Cloudflare Workers AI FLUX.1 schnell", voice: "Google Translate TTS Burmese (no API key; best-effort)" }
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
    story.scenes = story.scenes.map((s, i) => ({
      id: i + 1, title: String(s.title || `Scene ${i + 1}`), narration: String(s.narration || ""),
      visual_prompt: String(s.visual_prompt || `${style}, cinematic story illustration`),
      camera: ["slow push-in", "slow pan left", "slow pan right"].includes(s.camera) ? s.camera : "slow push-in",
      image: null, audio: null
    }));
    res.json(story);
  } catch (err) {
    const e = friendlyError(err); res.status(e.status).json({ error: e.message });
  }
});

app.post("/api/image", async (req, res) => {
  try {
    const { prompt, style = "2.5D Cinematic Fantasy" } = req.body || {};
    if (!prompt || typeof prompt !== "string") return res.status(400).json({ error: "Image prompt မရှိပါ။" });
    if (!hasCloudflare()) throw httpError("Render Environment မှာ CLOUDFLARE_ACCOUNT_ID နဲ့ CLOUDFLARE_API_TOKEN ထည့်ပါ။ Cloudflare Workers AI Free allocation ကို အသုံးပြုနိုင်ပါတယ်။", 400);
    const imagePrompt = `${style}. One polished cinematic 2.5D animation keyframe, layered foreground, midground and background for parallax camera movement, beautiful lighting, consistent character design, no letters, no subtitles, no watermark. Scene: ${prompt}`;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CLOUDFLARE_ACCOUNT_ID)}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
    const result = await fetchJson(url, {
      method: "POST", headers: { "Authorization": `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: imagePrompt, steps: 4 })
    }, "Cloudflare Workers AI");
    if (!result.image) throw httpError("Image API က ပုံမပြန်ပေးခဲ့ပါ။ Cloudflare Workers AI quota နဲ့ model access ကို စစ်ပါ။", 502);
    res.json({ image: `data:image/jpeg;base64,${result.image}` });
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

app.listen(Number(process.env.PORT) || 3000, () => console.log(`StoryMotion running on port ${Number(process.env.PORT) || 3000}`));
