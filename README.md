# Full AI StoryMotion Studio — Flow-inspired Prompt-to-Movie

A Node.js/Express app with a cinematic AI filmmaking workspace inspired by common AI video-studio workflows: prompt composer, character/reference ingredients, start frame, per-clip camera direction, clip timeline/reordering, dialogue audio, and MP4 assembly. This is an independent app and is not Google Flow and does not use Google's private Flow APIs.

## Prompt-first behavior

- The user writes the movie prompt. The app does not call Gemini to create a new story or rewrite the prompt.
- Each video generation request uses the user's exact prompt as its base text. The server appends clearly separated production metadata (aspect ratio, shot number/shot type, optional camera instruction) so clips can vary. Replicate prompt optimization is set to `false`.
- The chosen start-frame image is sent as `first_frame_image` and the character reference is sent as `subject_reference` to Replicate's `minimax/video-01` API.
- The UI lets users upload an end frame as a visual reference, but the configured model endpoint currently only sends the start frame; end-frame-conditioned generation is not implemented.
- Generated clips can be previewed, reordered in the timeline, regenerated individually, downloaded individually, and assembled into an MP4 with FFmpeg.
- Movie target estimates about 10 clips/minute because the configured model generates approximately 6-second clips. Five minutes is about 50 separate generations and may be expensive and slow. Always preview one clip first.

## Required API

### Replicate video generation

1. Create a token at https://replicate.com/account/api-tokens.
2. Add `REPLICATE_API_TOKEN` in Render → Web Service → Environment.
3. The app calls `https://api.replicate.com/v1/models/minimax/video-01/predictions` and polls each prediction until it completes.
4. The configured model supports prompt, `first_frame_image`, and `subject_reference` inputs. Check the current model schema/pricing before use: https://replicate.com/minimax/video-01/api.
5. This is a paid API model, not a guaranteed free tier. Check pricing before generating a full movie.

## Voice and sound limitations

- The configured video model may produce silent clips. The user can add dialogue text and create Burmese TTS audio with the existing Google Translate TTS endpoint, or upload a separate audio track per clip.
- Built-in Burmese TTS uses one voice; true per-character voice cloning/multi-speaker synthesis is not implemented.
- Audio is muxed per clip during MP4 assembly; this is not guaranteed lip-sync and does not automatically generate dialogue from the original prompt.

## Render environment variables

- `REPLICATE_API_TOKEN` — required for video generation and MP4 assembly.
- `GEMINI_API_KEY`, `GEMINI_MODEL` — legacy story endpoint only; not required for Prompt-to-Movie.
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` — legacy image endpoint only; not required for Prompt-to-Movie.

Never put API tokens in GitHub or browser code.

## Deploy on Render

1. Extract the ZIP and upload the contents of `Full_AI_StoryMotion/` to the root of a GitHub repository.
2. Create a Render Web Service. Runtime: Node; Build Command: `npm install`; Start Command: `npm start`.
3. Add `REPLICATE_API_TOKEN` in Environment.
4. Deploy and open the service URL. Write a prompt and generate a preview first.

## Runtime notes

- Requires Node.js 20+.
- `ffmpeg-static` is used for MP4 assembly and consumes CPU and temporary disk space. Render filesystems may be ephemeral; download the final MP4 promptly.
- Project data and reference assets live in the browser session; there is no database or durable job queue. Keep the browser tab open while generating multiple clips.
- The model may vary character details between clips. Reference images can help but do not guarantee perfect continuity.
- `/api/health` reports environment configuration only; it does not make a paid live API test call.

## Local development

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000`.
