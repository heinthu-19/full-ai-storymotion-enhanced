# Full AI StoryMotion Studio — Burmese Voice + 2.5D Edition

A Node.js/Express web app for Burmese story writing, scene breakdown, AI still images, Burmese narration and browser-side WebM video export.

## Included features

- Burmese story generation with Google Gemini (`GEMINI_API_KEY`)
- Scene-by-scene storyboard with English visual prompts and Burmese narration
- AI image generation through Cloudflare Workers AI FLUX.1 schnell
- Burmese TTS through Google Translate's `my` endpoint using `google-tts-api` (no API key)
- Individual image/voice regeneration per scene and batch generation for missing assets
- Preview canvas with 2.5D-style camera motion controls: Ken Burns, push-in, pull-out, pan left/right, floating drift and simulated depth parallax
- Optional title and Burmese narration overlays
- Part-based WebM export with narration audio mixed into the recording
- Storyboard JSON export and `/api/health` diagnostics
- Mobile-friendly UI for Android Chrome

## Important: what 2.5D means here

The app animates AI still images with crop/zoom/pan, a blurred backdrop, vignette and overlay. This creates a 2.5D-style camera move, but does **not** separate objects into true depth layers and does not animate a character's limbs, face or lips. True 2.5D requires a depth map/layer extraction workflow; character animation/lip-sync requires an additional animation/video model.

## Burmese voice choices

Default is Google Translate TTS (`lang=my`) through `google-tts-api`, which needs no Azure account and no TTS API key. This is a best-effort, unofficial endpoint: availability, voice style and request limits can change. It has limited voice controls and should not be treated as a guaranteed production API.

For a sample of a Burmese neural model, open the [F5 Myanmar TTS Demo](https://huggingface.co/spaces/freococo/F5-Myanmar-TTS-Demo) or the [MyanmarTTS model card](https://huggingface.co/freococo/MyanmarTTS). These are links for manual testing/reference, not automatically integrated into this app. MyanmarTTS model card lists CC0 for model weights/audio and MIT for supporting components; verify the current card and dependencies before deploying. Self-hosting needs CPU/GPU RAM and can exceed Render Free instance limits.

## Render deployment

1. Extract this ZIP.
2. Upload the contents of `Full_AI_StoryMotion/` to a GitHub repository. Do not upload `.env` or real API keys.
3. In Render, create a Web Service from that repository. Build command: `npm install`; Start command: `npm start`. Or use `render.yaml` as a Blueprint.
4. Add these environment variables in Render > Service > Environment:
   - `GEMINI_API_KEY` — Google AI Studio key
   - `GEMINI_MODEL` — optional; default is `gemini-2.5-flash`
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID
   - `CLOUDFLARE_API_TOKEN` — token with Workers AI permissions
5. Save and redeploy. Visit `https://YOUR-SERVICE.onrender.com/api/health`.
6. Open the main service URL in Android Chrome. Create the story, generate assets, then export one part at a time. Keep the tab open during export.

## Local development

Requires Node.js 20+.

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000`.

## Environment variables

See `.env.example`. Only Gemini and Cloudflare credentials are needed for AI story/images. Burmese TTS does not use Azure or a TTS API key.

## Limitations and troubleshooting

- Gemini and Cloudflare free-tier quotas/model access vary by account, region and current provider policy.
- Google Translate TTS may rate-limit or change; if voice generation fails, retry later or manually test the linked Burmese TTS demo/model.
- `/api/health` reports configuration, not whether provider credentials or the TTS endpoint are currently working.
- WebM export is done in the browser; Android memory limits can make long exports fail. Export shorter parts and keep the page foregrounded.
- Browser canvas export does not guarantee Burmese font availability on every device. Install/use a Myanmar-compatible browser font if text glyphs render incorrectly.
- Never expose API keys in client HTML, screenshots, public GitHub repositories or chat messages.
