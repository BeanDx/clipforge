// Авто-тайминг вставленного текста: нейросеть (Whisper, маленькая модель) слушает трек и даёт слова
// со временем. Слова она слышит неточно, но правильный текст уже есть у пользователя — нужно только
// понять, где какое слово звучит. Выравниваем две последовательности слов (как сравнение текстов:
// совпадения по похожести, пропуски с обеих сторон), начало строки — время её первого совпавшего
// слова; строки без совпадений встают между соседями пропорционально числу слов.

const normWord = (w) => w.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");
// цифры поют словами («911» — «девять один один»): раскрываем по одной цифре
const DIGITS = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const spoken = (w) => (/^\d{1,4}$/.test(w) ? [...w].map((d) => DIGITS[+d]) : [w]);

// похожесть двух слов 0..1 (по расстоянию Левенштейна)
function sim(a, b) {
  if (a === b) return 1;
  const n = a.length, m = b.length;
  if (!n || !m) return 0;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m);
}

// lines — строки текста (пустые пропускаются), words — [{ t: секунды, w: слово }] от Whisper.
// Возвращает [{ t, text }] — время начала каждой непустой строки.
export function alignLyrics(lines, words) {
  const rows = lines.map((l) => l.trim()).filter(Boolean);
  const r = alignCore(rows, words);
  if (!r) return rows.map((text, i) => ({ t: i * 3, text }));
  const out = rows.map((text, li) => {
    const first = r.U.findIndex((u) => u.line === li);
    return { text, t: first >= 0 ? r.timeOf(first) : null };
  });
  // строки без слов (только знаки) — сразу за предыдущей; время не убывает
  let last = 0;
  for (const x of out) { x.t = Math.max(last, x.t ?? last); last = x.t + 0.05; }
  return out;
}

// Время каждого слова строк (как они разбиты по пробелам): [[t | null, ...], ...] — для текста
// по слову на удар, где слово должно появляться ровно когда его поют, а не «примерно по длине».
export function alignWordTimes(rows, words) {
  const r = alignCore(rows, words);
  return rows.map((l, li) => l.split(/\s+/).map((_, wi) => {
    const i = r ? r.U.findIndex((u) => u.line === li && u.word === wi) : -1;
    return i >= 0 ? r.timeOf(i) : null;
  }));
}

function alignCore(rows, words) {
  const U = []; // слова текста: { w, line, word } — word: номер слова в строке (по пробелам)
  rows.forEach((l, li) => l.split(/\s+/).forEach((w, wi) => { const n = normWord(w); if (n) spoken(n).forEach((x) => U.push({ w: x, line: li, word: wi })); }));
  const R = words.map((x) => ({ t: x.t, w: normWord(x.w) })).filter((x) => x.w);
  const n = U.length, m = R.length;
  if (!n || !m) return null;
  // динамика: S[i][j] — лучший счёт для первых i слов текста и j распознанных
  const GAP = -0.35;
  const S = Array.from({ length: n + 1 }, () => new Float32Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1 — пара, 2 — пропуск в тексте, 3 — пропуск в распознанном
  for (let i = 1; i <= n; i++) { S[i][0] = i * GAP; B[i][0] = 2; }
  for (let j = 1; j <= m; j++) { S[0][j] = j * GAP; B[0][j] = 3; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = sim(U[i - 1].w, R[j - 1].w);
      // короткие слова («я», «и», «да») совпадают где угодно — почти не тянут выравнивание
      const short = U[i - 1].w.length < 3;
      const pair = S[i - 1][j - 1] + (s >= 0.45 ? (short ? s * 0.6 - 0.2 : s * 2 - 0.5) : -0.6);
      const up = S[i - 1][j] + GAP, left = S[i][j - 1] + GAP;
      if (pair >= up && pair >= left) { S[i][j] = pair; B[i][j] = 1; }
      else if (up >= left) { S[i][j] = up; B[i][j] = 2; }
      else { S[i][j] = left; B[i][j] = 3; }
    }
  }
  // обратный проход: какое распознанное слово досталось каждому слову текста
  // at — надёжная привязка (похожее слово от 3 букв), weak — просто время слова напротив (слово
  // не узналось, но стоит на том же месте: «сука я сегодня» услышано как «супьять с водя»)
  const at = new Array(n).fill(null), weak = new Array(n).fill(null);
  for (let i = n, j = m; i > 0 || j > 0;) {
    const b = B[i][j];
    if (b === 1) {
      if (sim(U[i - 1].w, R[j - 1].w) >= 0.45 && U[i - 1].w.length >= 3) at[i - 1] = R[j - 1].t;
      else weak[i - 1] = R[j - 1].t;
      i--; j--;
    }
    else if (b === 2) i--;
    else j--;
  }
  // время слова без пары — между соседними совпавшими словами пропорционально позиции
  const known = at.map((t, i) => (t == null ? null : i)).filter((i) => i != null);
  const timeOf = (i) => {
    if (at[i] != null) return at[i];
    // слабое время годится, если не противоречит надёжным соседям
    const pk = known.filter((k) => k < i).pop(), nk = known.find((k) => k > i);
    if (weak[i] != null && (pk == null || weak[i] >= at[pk]) && (nk == null || weak[i] <= at[nk])) return weak[i];
    const prev = known.filter((k) => k < i).pop(), next = known.find((k) => k > i);
    if (prev == null && next == null) return i * 0.5;
    if (prev == null) return Math.max(0, at[next] - (next - i) * 0.4);
    if (next == null) return at[prev] + (i - prev) * 0.4;
    return at[prev] + ((at[next] - at[prev]) * (i - prev)) / (next - prev);
  };
  return { U, timeOf };
}
