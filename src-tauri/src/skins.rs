// Скины через перезапись копии .dem: в игру ничего не внедряется, оригинал не меняется.
//
// В демке CS2 скин предмета хранится в его атрибутах: 6 — paint kit, 7 — seed, 8 — износ
// (m_AttributeManager.m_Item.m_NetworkedDynamicAttributes.m_Attributes.NNNN). source2-demo
// умеет заменять значения уже записанных полей, но не добавлять новые. Поэтому сменить
// можно только то, у чего в демке уже есть скин: у стандартной раскраски атрибутов нет.
use serde::{Deserialize, Serialize};
use source2_demo::prelude::*;
use source2_demo::proto::{c_demo_string_tables::ItemsT, CDemoStringTables};
use source2_demo::writer::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::thread;

const ITEM_ATTRS: &str = "m_AttributeManager.m_Item.m_NetworkedDynamicAttributes.m_Attributes.";
const ITEM_DEF: &str = "m_AttributeManager.m_Item.m_iItemDefinitionIndex";
const GLOVE_ATTRS: &str = "m_EconGloves.m_NetworkedDynamicAttributes.m_Attributes.";
const GLOVE_DEF: &str = "m_EconGloves.m_iItemDefinitionIndex";
const ATTR_PAINT: u16 = 6;
const ATTR_SEED: u16 = 7;
const ATTR_WEAR: u16 = 8;
// В сетевом хэндле индекс сущности — младшие 14 бит
const HANDLE_INDEX: u32 = 0x3FFF;

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct Finish {
    pub paint: u32,
    pub seed: u32,
    pub wear: f32,
}

#[derive(Serialize, Clone, Debug)]
pub struct Item {
    pub def: u16,
    pub class: String,
    // None — у предмета в демке нет атрибутов скина (стандартная раскраска), менять нечего
    pub finish: Option<Finish>,
}

#[derive(Serialize, Default)]
pub struct Scan {
    // оружие, которое игрок держал в руках во время выбранных клипов
    pub weapons: Vec<Item>,
    // ножи игрока за всю демку: за T и за CT они бывают разными
    pub knives: Vec<Item>,
    pub gloves: Option<Item>,
}

#[derive(Deserialize, Default)]
pub struct Plan {
    // ключ — индекс определения оружия (7 = AK-47) строкой, как в JSON
    #[serde(default)]
    pub weapons: HashMap<String, Finish>,
    // один нож на весь хайлайт: им становятся все ножи игрока (и за T, и за CT)
    #[serde(default)]
    pub knife: Option<KnifePlan>,
    #[serde(default)]
    pub gloves: Option<GlovesPlan>,
}

#[derive(Deserialize, Clone, Copy)]
pub struct KnifePlan {
    pub def: u16,
    // None — у ножа нет данных скина в демке, меняется только модель
    pub finish: Option<Finish>,
}

// Модель ножа: номер предмета меняет только подписи (килфид, HUD), а 3D-модель задаёт
// m_hModel — хэш пути к модели: MurmurHash64B с seed 0xEDABCDEF от
// "weapons/models/knife/<папка>/weapon_<папка>.vmdl" (сверено со всеми ножами тестовой демки).
const MODEL_FIELD: &str = "CBodyComponent.m_skeletonInstance.m_modelState.m_hModel";
const KNIFE_MODELS: &[(u16, &str)] = &[
    (42, "knife_default_ct"), (59, "knife_default_t"), (500, "knife_bayonet"), (503, "knife_css"),
    (505, "knife_flip"), (506, "knife_gut"), (507, "knife_karambit"), (508, "knife_m9"),
    (509, "knife_tactical"), (512, "knife_falchion"), (514, "knife_bowie"), (515, "knife_butterfly"),
    (516, "knife_push"), (517, "knife_cord"), (518, "knife_canis"), (519, "knife_ursus"),
    (520, "knife_navaja"), (521, "knife_outdoor"), (522, "knife_stiletto"), (523, "knife_talon"),
    (525, "knife_skeleton"), (526, "knife_kukri"),
];

// m_nSubclassID — по нему игра выбирает описание оружия (vdata) и граф анимаций.
// Это CUtlStringToken номера предмета: MurmurHash2 с seed 0x31415926 от строки "515".
//
// Модель новой модели ножа игра загружает синхронно только при загрузке демки. Нож, созданный
// по ходу игры с ещё не загруженной моделью, остаётся без раскраски. Поэтому новый нож получают
// все ножи игрока за всю демку — и самый первый, созданный при загрузке, подтягивает модель.
const SUBCLASS_FIELD: &str = "m_nSubclassID";
fn subclass_token(def: u16) -> u32 {
    murmur2(def.to_string().as_bytes(), 0x31415926)
}

fn murmur2(data: &[u8], seed: u32) -> u32 {
    const M: u32 = 0x5bd1e995;
    let mut h = seed ^ data.len() as u32;
    let chunks = data.chunks_exact(4);
    let tail = chunks.remainder();
    for c in chunks {
        let mut k = u32::from_le_bytes(c.try_into().unwrap());
        k = k.wrapping_mul(M);
        k ^= k >> 24;
        h = h.wrapping_mul(M) ^ k.wrapping_mul(M);
    }
    if tail.len() >= 3 { h ^= (tail[2] as u32) << 16; }
    if tail.len() >= 2 { h ^= (tail[1] as u32) << 8; }
    if !tail.is_empty() { h ^= tail[0] as u32; h = h.wrapping_mul(M); }
    h ^= h >> 13;
    h = h.wrapping_mul(M);
    h ^ (h >> 15)
}

fn knife_model_hash(def: u16) -> Option<u64> {
    let dir = KNIFE_MODELS.iter().find(|(d, _)| *d == def)?.1;
    Some(murmur64b(format!("weapons/models/knife/{dir}/weapon_{dir}.vmdl").as_bytes(), 0xEDABCDEF))
}

// MurmurHash2 64-битный, вариант для 32-битных платформ (MurmurHash64B) — так Source 2 хэширует пути ресурсов
fn murmur64b(data: &[u8], seed: u64) -> u64 {
    const M: u32 = 0x5bd1e995;
    const R: u32 = 24;
    let mix = |mut k: u32| { k = k.wrapping_mul(M); k ^= k >> R; k.wrapping_mul(M) };
    let rd = |i: usize| u32::from_le_bytes(data[i..i + 4].try_into().unwrap());
    let (mut h1, mut h2) = ((seed as u32) ^ (data.len() as u32), (seed >> 32) as u32);
    let (mut i, mut len) = (0, data.len());
    while len >= 8 {
        h1 = h1.wrapping_mul(M) ^ mix(rd(i));
        h2 = h2.wrapping_mul(M) ^ mix(rd(i + 4));
        i += 8;
        len -= 8;
    }
    if len >= 4 {
        h1 = h1.wrapping_mul(M) ^ mix(rd(i));
        i += 4;
        len -= 4;
    }
    if len >= 3 { h2 ^= (data[i + 2] as u32) << 16; }
    if len >= 2 { h2 ^= (data[i + 1] as u32) << 8; }
    if len >= 1 { h2 ^= data[i] as u32; h2 = h2.wrapping_mul(M); }
    h1 ^= h2 >> 18; h1 = h1.wrapping_mul(M);
    h2 ^= h1 >> 22; h2 = h2.wrapping_mul(M);
    h1 ^= h2 >> 17; h1 = h1.wrapping_mul(M);
    h2 ^= h1 >> 19; h2 = h2.wrapping_mul(M);
    ((h1 as u64) << 32) | h2 as u64
}

#[derive(Deserialize, Clone, Copy)]
pub struct GlovesPlan {
    // модель перчаток, к которой относится скин
    pub def: u16,
    pub finish: Finish,
}

fn is_weapon(class: &str) -> bool {
    class.starts_with("CWeapon") || matches!(class, "CAK47" | "CDEagle" | "CKnife" | "CKnifeGG")
}
fn is_knife(class: &str) -> bool {
    class.starts_with("CKnife")
}

fn as_u32(v: &FieldValue) -> Option<u32> {
    match v {
        FieldValue::Unsigned8(x) => Some(*x as u32),
        FieldValue::Unsigned16(x) => Some(*x as u32),
        FieldValue::Unsigned32(x) => Some(*x),
        FieldValue::Unsigned64(x) => Some(*x as u32),
        FieldValue::Signed32(x) => Some(*x as u32),
        _ => None,
    }
}
fn as_f32(v: &FieldValue) -> Option<f32> {
    if let FieldValue::Float(x) = v { Some(*x) } else { None }
}
fn prop_u32(e: &Entity, name: &str) -> Option<u32> {
    e.get_property(name).ok().and_then(as_u32)
}

// Индекс сущности персонажа (pawn) игрока с этим steamid, если он сейчас в игре
fn pawn_index(ctx: &Context, steamid: u64) -> Option<u32> {
    ctx.entities().iter()
        .filter(|e| e.class().name() == "CCSPlayerController")
        .find(|e| matches!(e.get_property("m_steamID"), Ok(FieldValue::Unsigned64(id)) if *id == steamid))
        .and_then(|c| prop_u32(c, "m_hPlayerPawn"))
        .map(|h| h & HANDLE_INDEX)
}

// Скин из атрибутов: (paint, seed, wear), если paint kit задан
fn read_finish(e: &Entity, attrs: &str) -> Option<Finish> {
    let (mut paint, mut seed, mut wear) = (None, 0.0, 0.0);
    for i in 0..32 {
        let Some(def) = prop_u32(e, &format!("{attrs}{i:04}.m_iAttributeDefinitionIndex")) else { break };
        let raw = e.get_property(&format!("{attrs}{i:04}.m_iRawValue32")).ok().and_then(as_f32).unwrap_or(0.0);
        match def as u16 {
            ATTR_PAINT => paint = Some(raw),
            ATTR_SEED => seed = raw,
            ATTR_WEAR => wear = raw,
            _ => {}
        }
    }
    paint.map(|p| Finish { paint: p as u32, seed: seed as u32, wear })
}

fn item_of(e: &Entity) -> Option<Item> {
    Some(Item { def: prop_u32(e, ITEM_DEF)? as u16, class: e.class().name().to_string(), finish: read_finish(e, ITEM_ATTRS) })
}

// Тяжёлый разбор демки: писателю и парсеру нужен большой стек (на 1 МБ главного потока он падает)
fn big_stack<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    thread::Builder::new().stack_size(512 << 20).spawn(f).map_err(|e| e.to_string())?
        .join().map_err(|_| "разбор демки аварийно завершился".to_string())?
}

// --- поиск предметов игрока в выбранных клипах ---

// Экземпляр оружия узнаём по любому из признаков: хэндл сущности, ID предмета (бывает нулевым
// на серверах с плагинами скинов) или аккаунт владельца скина. Один признак ненадёжен: одно и то
// же оружие встречается в демке под разными хэндлами (полные снимки, пересоздание).
#[derive(Hash, PartialEq, Eq, Clone, Copy, Debug)]
enum ItemId {
    Handle(u32),
    Econ(u32, u32),
}

fn item_ids(e: &Entity) -> Vec<ItemId> {
    let mut ids = vec![ItemId::Handle(e.handle())];
    let econ = (prop_u32(e, "m_AttributeManager.m_Item.m_iItemIDHigh"), prop_u32(e, "m_AttributeManager.m_Item.m_iItemIDLow"));
    if let (Some(h), Some(l)) = econ { if (h, l) != (0, 0) { ids.push(ItemId::Econ(h, l)); } }
    ids
}

const STEAM64_BASE: u64 = 76561197960265728;
fn owned_skin(e: &Entity, steamid: u64) -> bool {
    prop_u32(e, "m_AttributeManager.m_Item.m_iAccountID").is_some_and(|a| a as u64 + STEAM64_BASE == steamid)
}

#[derive(Default)]
struct Scanner {
    steamid: u64,
    ranges: Vec<(u32, u32)>,
    weapons: BTreeMap<u16, Item>,
    knives: BTreeMap<u16, Item>,
    gloves: Option<Item>,
    // экземпляры со скином, которые игрок держал в клипах (оружие и ножи) — по ним и меняем скин
    weapon_ids: HashMap<ItemId, u16>,
    // (оружие, paint kit) у того, что игрок держал: по ним узнаём скин в baseline класса
    held_paints: HashSet<(u16, u32)>,
}

impl Observer for Scanner {
    fn interests(&self) -> Interests {
        Interests::TICK_END | Interests::ENTITY_STATE
    }
    fn on_tick_end(&mut self, ctx: &Context) -> ObserverResult {
        let t = ctx.tick();
        if t % 8 != 0 { return Ok(()); }
        // огнестрел — только из выбранных клипов, ножи — за всю демку (см. KnifePlan)
        let in_clips = self.ranges.iter().any(|&(a, b)| t >= a && t <= b);
        let Some(pi) = pawn_index(ctx, self.steamid) else { return Ok(()) };
        let Ok(pawn) = ctx.entities().get_by_index(pi as usize) else { return Ok(()) };

        if let Some(h) = prop_u32(pawn, "m_pWeaponServices.m_hActiveWeapon").filter(|_| in_clips) {
            if let Ok(w) = ctx.entities().get_by_index((h & HANDLE_INDEX) as usize) {
                if is_weapon(w.class().name()) && !is_knife(w.class().name()) {
                    if let Some(item) = item_of(w) {
                        if let Some(f) = item.finish {
                            for id in item_ids(w) { self.weapon_ids.insert(id, item.def); }
                            self.held_paints.insert((item.def, f.paint));
                        }
                        // скин предпочтительнее: если игрок держал и стандартный, и скиновый экземпляр
                        let better = self.weapons.get(&item.def).is_none_or(|old| old.finish.is_none());
                        if better { self.weapons.insert(item.def, item); }
                    }
                }
            }
        }
        // ножи — среди всего оружия игрока, даже если в клипе он его не доставал
        for i in 0..16 {
            let Some(h) = prop_u32(pawn, &format!("m_pWeaponServices.m_hMyWeapons.{i:04}")) else { break };
            if let Ok(w) = ctx.entities().get_by_index((h & HANDLE_INDEX) as usize) {
                if is_knife(w.class().name()) {
                    if let Some(item) = item_of(w) {
                        // нож запоминаем и без скина: ему можно сменить модель
                        for id in item_ids(w) { self.weapon_ids.insert(id, item.def); }
                        if let Some(f) = item.finish { self.held_paints.insert((item.def, f.paint)); }
                        let better = self.knives.get(&item.def).is_none_or(|old| old.finish.is_none());
                        if better { self.knives.insert(item.def, item); }
                    }
                }
            }
        }
        if in_clips && self.gloves.as_ref().is_none_or(|g| g.finish.is_none()) {
            let def = prop_u32(pawn, GLOVE_DEF).unwrap_or(0) as u16;
            self.gloves = Some(Item { def, class: "gloves".into(), finish: read_finish(pawn, GLOVE_ATTRS) });
        }
        Ok(())
    }
}

// Синхронный проход сканера (вызывается в потоке с большим стеком)
fn run_scan(path: &str, steamid: u64, ranges: Vec<(u32, u32)>) -> Result<Scanner, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut parser = Parser::from_reader(BufReader::new(file)).map_err(|e| e.to_string())?;
    let s = parser.register_observer::<Scanner>();
    {
        let mut s = s.borrow_mut();
        s.steamid = steamid;
        s.ranges = ranges;
    }
    parser.run_to_end().map_err(|e| e.to_string())?;
    let s = std::mem::take(&mut *s.borrow_mut());
    Ok(s)
}

#[tauri::command]
pub async fn scan_items(path: String, steamid: String, ranges: Vec<(u32, u32)>) -> Result<Scan, String> {
    let steamid: u64 = steamid.parse().map_err(|_| "неверный steamid")?;
    big_stack(move || {
        let s = run_scan(&path, steamid, ranges)?;
        Ok(Scan { weapons: s.weapons.into_values().collect(), knives: s.knives.into_values().collect(), gloves: s.gloves })
    })
}

// --- перезапись скинов ---

// Скин отправляется в демку один раз, при создании оружия, и владельца в этот момент может ещё
// не быть (или оружие потом подбирают). Поэтому меняем по ID экземпляров, найденных сканером:
// один и тот же ствол выглядит одинаково, у кого бы он ни оказался.
#[derive(Default)]
struct Painter {
    steamid: u64,
    plan: Plan,
    weapon_ids: HashMap<ItemId, u16>,
    held_paints: HashSet<(u16, u32)>,
    // исходный номер ножа по хэндлу экземпляра (после замены номер в состоянии уже новый)
    orig_def: HashMap<u32, u16>,
    // Таблица AnimAssetData: без строки скелета новой модели ножа игра падает при её загрузке.
    // Ключи и значение строки ножа из исходной таблицы, сколько строк было при создании
    // и сколько мы вставили (на столько сдвигаются индексы более поздних строк).
    anim_keys: HashSet<String>,
    anim_knife_value: Option<Vec<u8>>,
    anim_base: Option<i32>,
    anim_inserted: Vec<(String, Vec<u8>)>,
    changed: u32,
}

const ANIM_TABLE: &str = "AnimAssetData";
// Значение строки скелета ножа одинаково у всех ножей: кости weapon, weapon_offset, econ
const KNIFE_SKELETON_VALUE: &[u8] = b"\x01\x00\x00\x00\x03\x00\x00\x00weapon\0weapon_offset\0econ\0\0\0\0\0\0";

fn knife_skeleton_key(def: u16) -> Option<String> {
    let dir = KNIFE_MODELS.iter().find(|(d, _)| *d == def)?.1;
    Some(format!("animation/skeletons/weapons/{dir}.vnmskel"))
}

impl Painter {
    // Персонаж принадлежит игроку: его контроллер — с нужным steamid
    fn is_player_pawn(&self, ctx: &Context, pawn: &Entity) -> bool {
        prop_u32(pawn, "m_hController")
            .and_then(|h| ctx.entities().get_by_index((h & HANDLE_INDEX) as usize).ok())
            .is_some_and(|c| matches!(c.get_property("m_steamID"), Ok(FieldValue::Unsigned64(id)) if *id == self.steamid))
    }

    // Подмена значения атрибута скина (6/7/8) в слоте `slot` списка атрибутов `attrs`
    fn finish_field(e: &Entity, attrs: &str, rest: &str, f: &Finish) -> Option<FieldValue> {
        let (slot, field) = rest.split_once('.')?;
        if field != "m_iRawValue32" && field != "m_flInitialValue" { return None; }
        let def = prop_u32(e, &format!("{attrs}{slot}.m_iAttributeDefinitionIndex"))? as u16;
        let v = match def {
            ATTR_PAINT => f.paint as f32,
            ATTR_SEED => f.seed as f32,
            ATTR_WEAR => f.wear,
            _ => return None,
        };
        Some(FieldValue::Float(v))
    }
}

impl DemoRewriter for Painter {
    // Интересы писатель запоминает при регистрации, когда план ещё не задан, — поэтому всегда все
    fn interests(&self) -> RewriteInterests {
        RewriteInterests::ENTITY_FIELDS | RewriteInterests::STRING_TABLE_ENTRIES | RewriteInterests::DEMO_STRING_TABLES
    }

    // Строки AnimAssetData: при создании таблицы запоминаем ключи (и значение строки ножа),
    // в последующих обновлениях сдвигаем индексы на число вставленных строк
    fn rewrite_string_table_entry(&mut self, _: &Context, _: u32, table: &str, entry: &mut StringTableEntryUpdate) -> Result<(), ParserError> {
        if table != ANIM_TABLE { return Ok(()); }
        match self.anim_base {
            None => {
                if let Some(k) = entry.key() {
                    if k.contains("/weapons/knife_") && self.anim_knife_value.is_none() {
                        self.anim_knife_value = entry.value().map(<[u8]>::to_vec);
                    }
                    self.anim_keys.insert(k.to_string());
                }
            }
            Some(base) => {
                let shift = self.anim_inserted.len() as i32;
                if shift > 0 && entry.index() >= base { entry.set_index(entry.index() + shift); }
            }
        }
        Ok(())
    }

    // Дописываем строки скелетов новых моделей ножей сразу после исходных строк — так же,
    // как это делает nSkinz: строка должна быть в начальном сообщении создания таблицы
    fn insert_string_table_entries(&mut self, _: &Context, table: &str, next: i32) -> Vec<StringTableEntryUpdate> {
        if table != ANIM_TABLE || self.anim_base.is_some() { return Vec::new(); }
        self.anim_base = Some(next);
        let value = self.anim_knife_value.clone().unwrap_or_else(|| KNIFE_SKELETON_VALUE.to_vec());
        if let Some(key) = self.plan.knife.and_then(|k| knife_skeleton_key(k.def)) {
            if self.anim_keys.insert(key.clone()) { self.anim_inserted.push((key, value)); }
        }
        self.anim_inserted.iter().enumerate()
            .map(|(i, (k, v))| StringTableEntryUpdate::new_inserted(next + i as i32, k.clone(), v.clone()))
            .collect()
    }

    // Полные снимки таблиц (по ним идёт перемотка): те же строки на той же позиции
    fn rewrite_demo_string_tables(&mut self, _: &Context, _: u32, msg: &mut CDemoStringTables) -> Result<MessageRewrite, ParserError> {
        let Some(base) = self.anim_base else { return Ok(MessageRewrite::Keep) };
        if self.anim_inserted.is_empty() { return Ok(MessageRewrite::Keep); }
        let mut changed = false;
        for t in msg.tables.iter_mut().filter(|t| t.table_name() == ANIM_TABLE) {
            let have: HashSet<String> = t.items.iter().filter_map(|i| i.str.clone()).collect();
            let at = (base as usize).min(t.items.len());
            let rows: Vec<_> = self.anim_inserted.iter().filter(|(k, _)| !have.contains(k))
                .map(|(k, v)| ItemsT { str: Some(k.clone()), data: Some(v.clone()) })
                .collect();
            if rows.is_empty() { continue; }
            t.items.splice(at..at, rows);
            changed = true;
        }
        Ok(if changed { MessageRewrite::Rewrite } else { MessageRewrite::Keep })
    }
    // На этом шаге поля пакета ещё не разобраны — фильтруем только по классу
    fn should_rewrite_entity(&mut self, _: &Context, _: EntityEvents, e: &Entity) -> bool {
        let c = e.class().name();
        is_weapon(c) || c == "CCSPlayerPawn"
    }
    // Здесь поля текущего пакета (в том числе ID предмета и контроллер) уже в состоянии
    fn replace_entity_field(&mut self, ctx: &Context, _: EntityEvents, e: &Entity, name: &str, _v: &FieldValue) -> Option<FieldValue> {
        let class = e.class().name();
        let out = if class == "CCSPlayerPawn" {
            let g = self.plan.gloves?;
            let rest = name.strip_prefix(GLOVE_ATTRS)?;
            // скин только для той же модели перчаток и только у персонажа игрока
            if prop_u32(e, GLOVE_DEF)? as u16 != g.def || !self.is_player_pawn(ctx, e) { return None; }
            Self::finish_field(e, GLOVE_ATTRS, rest, &g.finish)
        } else {
            let (is_def, is_model, is_sub, rest) = (name == ITEM_DEF, name == MODEL_FIELD, name == SUBCLASS_FIELD, name.strip_prefix(ITEM_ATTRS));
            if !is_def && !is_model && !is_sub && rest.is_none() { return None; }
            let knife = is_knife(class);
            // Исходная модель предмета: после замены номер в состоянии уже новый,
            // поэтому у ножа запоминаем исходный номер по экземпляру
            let cur = prop_u32(e, ITEM_DEF)? as u16;
            let orig = if knife { self.orig_def.get(&e.handle()).copied().unwrap_or(cur) } else { cur };
            let (swap, f) = if knife {
                let k = self.plan.knife?;
                ((k.def != orig).then_some(k.def), k.finish)
            } else {
                (None, self.plan.weapons.get(&orig.to_string()).copied())
            };
            if swap.is_none() && f.is_none() { return None; }
            // Совпадающие с baseline класса значения демка не передаёт, и скин такого оружия живёт
            // только в baseline (сущность с индексом 0). Переписываем его, если там тот же скин,
            // что игрок держал в клипах. paint в состоянии меняется по ходу замены полей,
            // поэтому уже подставленный новый скин тоже считается «своим».
            let baseline = e.index() == 0 && e.handle() == 0;
            let mine = if baseline {
                read_finish(e, ITEM_ATTRS).is_some_and(|c| self.held_paints.contains(&(orig, c.paint)) || f.is_some_and(|f| f.paint == c.paint))
            } else {
                item_ids(e).iter().any(|id| self.weapon_ids.contains_key(id)) || owned_skin(e, self.steamid)
            };
            if !mine { return None; }
            if is_def {
                if swap.is_some() && !baseline { self.orig_def.insert(e.handle(), orig); }
                swap.map(FieldValue::Unsigned16)
            }
            else if is_model { swap.and_then(knife_model_hash).map(FieldValue::Unsigned64) }
            else if is_sub { swap.map(|d| FieldValue::Unsigned32(subclass_token(d))) }
            else { Self::finish_field(e, ITEM_ATTRS, rest?, f.as_ref()?) }
        };
        if out.is_some() { self.changed += 1; }
        out
    }
}

// Пишет копию демки с подменёнными скинами; возвращает число изменённых значений
#[tauri::command]
pub async fn rewrite_skins(input: String, output: String, steamid: String, ranges: Vec<(u32, u32)>, plan: Plan) -> Result<u32, String> {
    let steamid: u64 = steamid.parse().map_err(|_| "неверный steamid")?;
    big_stack(move || {
        // проход 1: какие именно экземпляры оружия игрок держал в клипах
        let scan = run_scan(&input, steamid, ranges)?;
        if let Some(dir) = std::path::Path::new(&output).parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // проход 2: перезапись
        let input = BufReader::new(File::open(&input).map_err(|e| e.to_string())?);
        let out = BufWriter::new(File::create(&output).map_err(|e| e.to_string())?);
        let mut writer = DemoWriter::from_reader(input, out).map_err(|e| e.to_string())?;
        let p = writer.register_rewriter::<Painter>();
        {
            let mut p = p.borrow_mut();
            p.steamid = steamid;
            p.plan = plan;
            p.weapon_ids = scan.weapon_ids;
            p.held_paints = scan.held_paints;
        }
        writer.run().map_err(|e| e.to_string())?;
        let changed = p.borrow().changed;
        Ok(changed)
    })
}
