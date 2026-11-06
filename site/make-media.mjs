// Видео для лендинга из готовых клипов clipforge. Нужен ffmpeg (в PATH или в переменной FFMPEG).
//
//   node site/make-media.mjs reel  "<клип.mp4>" [начало_с] [длина_с] [ru|en]
//       → site/media/reel.mp4 + reel.jpg (шоурил: без звука, 1280×720, 30 fps);
//         с языком — reel-en.mp4 / reel-ru.mp4: свой ролик для версии сайта на этом языке
//   node site/make-media.mjs ba    "<сырой дубль.mp4>" "<готовый клип.mp4>" [начало_с] [длина_с]
//       → site/media/before.mp4 + after.mp4 (шторка «до / после»: одна длина, один размер)
//
// Пара для шторки: сырой дубль лежит в <папка клипов>\.clipforge_last\takeNNNN\video.mp4,
// готовый кусок — в .clipforge_edit\...\part_NN.mp4 (сопоставление — .clipforge_last\compare.json).
// Берите клип с заметными эффектами (вспышка, зум, slow-mo, цвет), иначе разницы не видно.
import { execFileSync } from "node:child_process";
const run = execFileSync;
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FF = process.env.FFMPEG || "ffmpeg";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "media");
mkdirSync(OUT, { recursive: true });
const VF = "scale=1280:720:flags=lanczos,setsar=1,fps=30";
const ENC = ["-an", "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
const ff = (args) => execFileSync(FF, ["-v", "error", "-y", ...args], { stdio: "inherit" });

const [mode, ...a] = process.argv.slice(2);
if (mode === "reel" && a[0]) {
  const [src, ss = "0", t = "11", l] = a;
  const name = l ? `reel-${l}` : "reel";
  ff(["-ss", ss, "-t", t, "-i", src, "-vf", VF, ...ENC, join(OUT, `${name}.mp4`)]);
  ff(["-ss", String(Number(t) * 0.7), "-i", join(OUT, `${name}.mp4`), "-frames:v", "1", "-q:v", "4", join(OUT, `${name}.jpg`)]);
  console.log(`site/media/${name}.mp4, ${name}.jpg`);
} else if (mode === "ba" && a[1]) {
  const [raw, done, ss = "0", t = "4"] = a;
  ff(["-ss", ss, "-t", t, "-i", raw, "-vf", VF, ...ENC, join(OUT, "before.mp4")]);
  ff(["-ss", ss, "-t", t, "-i", done, "-vf", VF, ...ENC, join(OUT, "after.mp4")]);
  console.log("site/media/before.mp4, after.mp4");
} else {
  console.log('usage:\n  node site/make-media.mjs reel "<clip.mp4>" [start] [duration]\n  node site/make-media.mjs ba "<raw.mp4>" "<edited.mp4>" [start] [duration]');
  process.exit(1);
}
// обновить site/available.json, чтобы сайт увидел новые файлы
if (mode === "reel" || mode === "ba") run(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "scan.mjs")], { stdio: "inherit" });
