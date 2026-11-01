<div align="center">

<img src="docs/banner.webp" alt="clipforge" width="100%">

**English** · [Русский](README.ru.md)

[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0c1016?style=for-the-badge&logo=windows&logoColor=2ee6c0)](#requirements)
[![Tauri](https://img.shields.io/badge/Tauri-2-0c1016?style=for-the-badge&logo=tauri&logoColor=f5c518)](https://tauri.app)
[![React](https://img.shields.io/badge/React-19-0c1016?style=for-the-badge&logo=react&logoColor=2ee6c0)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-stable-0c1016?style=for-the-badge&logo=rust&logoColor=f5c518)](https://www.rust-lang.org)
[![License](https://img.shields.io/badge/license-MIT-0c1016?style=for-the-badge&logoColor=2ee6c0)](LICENSE)
[![Stars](https://img.shields.io/github/stars/BeanDx/clipforge?style=for-the-badge&color=f5c518&labelColor=0c1016)](https://github.com/BeanDx/clipforge/stargazers)

**Drop in a CS2 demo, get ready-to-post highlight edits.**<br>
clipforge finds your best moments, records them in-game through HLAE and adds slow-mo, music with 3D lyrics, skins and a victim POV replay. No video editor needed.

</div>

<br>

<p align="center"><img src="docs/screenshots/demo-en.webp" alt="clipforge main screen" width="100%"></p>

## Features

### ✦ Smart moment picking
Every round of every player gets a score and tags, the way highlight services do it, but using everything the demo has.

- **Multi-kills** 2K, 3K, 4K, ACE, with a bonus for speed ("3K in 2.1 s")
- **Real clutches 1vN**: when you were the last one alive, against how many, and whether your team won the round
- **Style kills**: wallbangs, through smoke, no-scopes, jump shots, while blind, knife, zeus, 40+ m kills, collaterals
- **Context**: opening kills, eco rounds, pistol rounds, the deciding round, ninja defuses
- Tiers from **Good** to **Legendary**, sorted best first, picked automatically

<p align="center"><img src="docs/screenshots/moments-en.webp" alt="Smart moments" width="100%"></p>

### 🎬 Effects that look like an edit
- **Slow motion** around kills with smooth ramps, audio slowed with Rubber Band so gunshots stay crisp
- **Kill flash** (pink, white or gold glow) and **headshot zoom**
- **Beat-synced zoom and shake** from the track's kick and bass
- **Atmosphere**: Night, Fog, Sunset, Neon, as a color grade plus real in-game fog and sky through HLAE
- **Damage numbers** next to the crosshair, a full **match HUD** drawn from demo data, or a clean killfeed-only view
- Frame blending, any resolution and aspect ratio, **stretched 4:3**, GPU encoding (NVENC, AMF, Quick Sync)

<p align="center"><img src="docs/screenshots/studio-effects-en.webp" alt="Clip settings" width="100%"></p>

### ♪ Music and lyrics in the map
- Add your own track, synced lyrics are fetched from LRCLIB (or paste your own and mark the lines with Space)
- Lyrics float in 3D inside the map with a karaoke highlight
- The chorus lands exactly on your last kill, together with a smooth slow-mo

### ◉ Cinematic camera
- **Victim POV replay**: after the clip, every kill is replayed through the eyes of the player you killed
- **Orbit camera** around the player after the final kill (experimental)

### ◆ Skins
Change weapon skins, the knife model and finish, and gloves. clipforge writes a modified copy of the demo, so nothing touches your inventory or the game files.

### 📊 Match stats
Things the scoreboard doesn't show: crosshair codes (one click to copy), accuracy, counter-strafing, time to kill, opening duels, distance run, chat and server settings. Optional FACEIT levels with your own API key.

### 🖼 Highlights gallery, player card and more
- A gallery of finished clips with previews, sorting, filters and a built-in player
- A **1080×1920 player card** for stories or Discord, copied to the clipboard in one click
- **Before / after** slider: raw demo vs the finished clip, same moment
- A hint on top of CS2 shows which key starts recording and the live progress. It never ends up in the video
- A notification when your highlight is ready
- English and Russian interface, switched live

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/gallery-en.webp" alt="Highlights gallery"></td>
    <td width="50%"><img src="docs/screenshots/overlay-en.webp" alt="In-game hint and notification"></td>
  </tr>
  <tr>
    <td align="center"><sub>Highlights gallery</sub></td>
    <td align="center"><sub>In-game hint and "highlight ready" notification</sub></td>
  </tr>
</table>

<p align="center"><img src="docs/screenshots/card-en.webp" alt="Player card" width="420"></p>

## How it works

```
 .dem ──► demoparser2 ──► moments + stats ──► you pick the clips
                                                    │
        skins? ──► source2-demo rewrites a copy ◄───┘
                                                    │
 CS2 + HLAE plays the demo, you press F10 ──► raw frames + audio
                                                    │
 ffmpeg: blend, slow-mo, HUD, lyrics, flash, zoom, music ──► .mp4
```

1. The demo is parsed with **demoparser2**: kills, damage, positions, rounds, equipment.
2. Moments are scored and shown on a round timeline.
3. If you changed skins, the demo copy is rewritten with **source2-demo**.
4. **CS2 launches through HLAE** with the demo. You can watch it first, recording starts when you press the hotkey (F10 by default).
5. HLAE records frames straight from the engine. **ffmpeg** then puts the clip together with all the effects.

## Requirements

**To use:**
- Windows 10 or 11
- [Counter-Strike 2](https://store.steampowered.com/app/730) installed through Steam
- [HLAE](https://www.advancedfx.org) (Half-Life Advanced Effects). Its ffmpeg is used for encoding, so nothing else is needed

**To build from source, also:**
- [Node.js](https://nodejs.org) 18 or newer
- [Rust](https://rustup.rs) stable and the Visual Studio C++ build tools
- WebView2 (already part of Windows 10/11)

## Getting started

**Installer:** download `clipforge_x.y.z_x64-setup.exe` from [Releases](https://github.com/BeanDx/clipforge/releases) and run it. Everything it needs is inside, including its own copy of Node.js for demo parsing.

**From source:**

```bash
git clone https://github.com/BeanDx/clipforge.git
cd clipforge
npm install
npx tauri dev
```

Build an installer:

```bash
npx tauri build
```

The installer ends up in `src-tauri/target/release/bundle/`.

**First run:**
1. Open **Settings** and check the paths to `HLAE.exe` and `cs2.exe` (they're found automatically when possible) and the output folder.
2. Drop a `.dem` file on the **Demo** tab.
3. Pick a player in **Match stats**, choose moments, tweak **Clip settings**.
4. Press **Start render**, wait for the demo to load in CS2 and press **F10**.
5. After pressing F10 you can alt-tab and do something else, recording keeps going. When it's done you get a notification and the clips land in **Highlights**.

## FAQ

<details>
<summary><b>Can I get VAC banned for this?</b></summary>
<br>
CS2 is started through HLAE with <code>-insecure</code>, which means VAC is off for that session and you can't join secured servers with it. clipforge only plays demos locally. Close the game afterwards (clipforge does it for you) and start CS2 normally before playing matchmaking.
</details>

<details>
<summary><b>Do I need a FACEIT API key?</b></summary>
<br>
No. It's only used to show FACEIT levels and Elo in Match stats. Everything else works without it.
</details>

<details>
<summary><b>Are skin changes visible to anyone else?</b></summary>
<br>
No. clipforge writes a modified copy of the demo file and records from it. Your inventory, the game and the original demo stay untouched.
</details>

<details>
<summary><b>Which demos work?</b></summary>
<br>
CS2 demos from FACEIT, Valve matchmaking and Premier, and SourceTV demos from community servers.
</details>

## Built with

| | |
|---|---|
| [Tauri 2](https://tauri.app) | desktop shell, Rust backend |
| [React 19](https://react.dev) + [Vite](https://vite.dev) | interface |
| [demoparser2](https://github.com/LaihoE/demoparser) | CS2 demo parsing |
| [source2-demo](https://crates.io/crates/source2-demo) | demo rewriting for skins (a patched copy lives in `src-tauri/vendor`) |
| [HLAE](https://github.com/advancedfx/advancedfx) | in-game recording, camera paths, sky and colors |
| [ffmpeg](https://ffmpeg.org) | post-processing and encoding |
| [LRCLIB](https://lrclib.net) | synced lyrics |
| [CSGO-API](https://github.com/ByMykel/CSGO-API) | skin catalog and images |
| [FACEIT Data API](https://developers.faceit.com) | optional player levels |

## Roadmap

- [x] Prebuilt installer
- [ ] Auto-updates
- [ ] First-run setup wizard
- [ ] Batch rendering of several demos
- [ ] Kill tags in the video (WALLBANG, 1v3 CLUTCH)
- [ ] Trimming and export presets for TikTok and Discord
- [ ] Personal records and achievements across all demos

Ideas and bug reports are welcome in [Issues](https://github.com/BeanDx/clipforge/issues).

## License

[MIT](LICENSE) © BeanDx

<sub>clipforge is not affiliated with or endorsed by Valve Corporation or FACEIT. Counter-Strike is a trademark of Valve Corporation.</sub>
