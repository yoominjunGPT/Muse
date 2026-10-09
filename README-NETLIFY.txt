Muse YouTube MP3 — Netlify deployment
===================================

Project root:
  index.html
  package.json
  netlify.toml
  netlify/functions/youtube-to-mp3.mjs

IMPORTANT:
- Deploy the extracted project folder as the Netlify site root, not a ZIP nested inside another folder.
- After deployment, open:
  /.netlify/functions/youtube-to-mp3
  A successful deployment responds with JSON containing "ok": true.
- The MP3 converter is intended only for content you have permission to download.

Main bug fixed:
The previous function called Node spawn() with the wrong argument shape:
  spawn(ffmpegPath, { args: [...] })
It must be:
  spawn(ffmpegPath, [...], {...})
