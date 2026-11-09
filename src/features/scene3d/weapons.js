// Модель оружия в руках по имени из демки (active_weapon_name у demoparser2). Модели берутся из
// pak01 установленной CS2 (Source 2 Viewer, см. scene3d.rs), сами в программе не хранятся.
const W = "weapons/models/";
const MODELS = {
  "AK-47": "ak47/weapon_rif_ak47", "M4A4": "m4a4/weapon_rif_m4a4", "M4A1-S": "m4a1_silencer/weapon_rif_m4a1_silencer",
  "AUG": "aug/weapon_rif_aug", "SG 553": "sg556/weapon_rif_sg556", "FAMAS": "famas/weapon_rif_famas", "Galil AR": "galilar/weapon_rif_galilar",
  "AWP": "awp/weapon_snip_awp", "SSG 08": "ssg08/weapon_snip_ssg08", "SCAR-20": "scar20/weapon_snip_scar20", "G3SG1": "g3sg1/weapon_snip_g3sg1",
  "MAC-10": "mac10/weapon_smg_mac10", "MP9": "mp9/weapon_smg_mp9", "MP7": "mp7/weapon_smg_mp7", "MP5-SD": "mp5sd/weapon_smg_mp5sd",
  "UMP-45": "ump45/weapon_smg_ump45", "P90": "p90/weapon_smg_p90", "PP-Bizon": "bizon/weapon_smg_bizon",
  "Nova": "nova/weapon_shot_nova", "XM1014": "xm1014/weapon_shot_xm1014", "Sawed-Off": "sawedoff/weapon_shot_sawedoff", "MAG-7": "mag7/weapon_shot_mag7",
  "M249": "m249/weapon_mach_m249", "Negev": "negev/weapon_mach_negev",
  "Glock-18": "glock18/weapon_pist_glock18", "USP-S": "usp_silencer/weapon_pist_usp_silencer", "P2000": "hkp2000/weapon_pist_hkp2000",
  "P250": "p250/weapon_pist_p250", "Five-SeveN": "fiveseven/weapon_pist_fiveseven", "Tec-9": "tec9/weapon_pist_tec9",
  "CZ75-Auto": "cz75a/weapon_pist_cz75a", "Desert Eagle": "deagle/weapon_pist_deagle", "R8 Revolver": "revolver/weapon_pist_revolver",
  "Dual Berettas": "elite/weapon_pist_elite", "Zeus x27": "taser/weapon_pist_taser",
  "Flashbang": "grenade/flashbang/weapon_flashbang", "High Explosive Grenade": "grenade/hegrenade/weapon_hegrenade",
  "Smoke Grenade": "grenade/smokegrenade/weapon_smokegrenade", "Molotov": "grenade/molotov/weapon_molotov",
  "Incendiary Grenade": "grenade/incendiary/weapon_incendiarygrenade", "Decoy Grenade": "grenade/decoy/weapon_decoy",
  "C4 Explosive": "c4/weapon_c4", "C4": "c4/weapon_c4",
  "knife": "knife/knife_default_ct/weapon_knife_default_ct", "knife_t": "knife/knife_default_t/weapon_knife_default_t",
  "Bayonet": "knife/knife_bayonet/weapon_knife_bayonet", "Bowie Knife": "knife/knife_bowie/weapon_knife_bowie",
  "Butterfly Knife": "knife/knife_butterfly/weapon_knife_butterfly", "Survival Knife": "knife/knife_canis/weapon_knife_canis",
  "Paracord Knife": "knife/knife_cord/weapon_knife_cord", "Classic Knife": "knife/knife_css/weapon_knife_css",
  "Falchion Knife": "knife/knife_falchion/weapon_knife_falchion", "Flip Knife": "knife/knife_flip/weapon_knife_flip",
  "Gut Knife": "knife/knife_gut/weapon_knife_gut", "Karambit": "knife/knife_karambit/weapon_knife_karambit",
  "Kukri Knife": "knife/knife_kukri/weapon_knife_kukri", "M9 Bayonet": "knife/knife_m9/weapon_knife_m9",
  "Navaja Knife": "knife/knife_navaja/weapon_knife_navaja", "Nomad Knife": "knife/knife_outdoor/weapon_knife_outdoor",
  "Shadow Daggers": "knife/knife_push/weapon_knife_push", "Skeleton Knife": "knife/knife_skeleton/weapon_knife_skeleton",
  "Stiletto Knife": "knife/knife_stiletto/weapon_knife_stiletto", "Huntsman Knife": "knife/knife_tactical/weapon_knife_tactical",
  "Talon Knife": "knife/knife_talon/weapon_knife_talon", "Ursus Knife": "knife/knife_ursus/weapon_knife_ursus",
};

export const weaponModel = (name) => (name && MODELS[name] ? `${W}${MODELS[name]}.vmdl_c` : null);
export const isKnife = (name) => !!name && /knife|bayonet|karambit|daggers/i.test(name);
export const isGrenade = (name) => !!name && /grenade|flashbang|molotov|decoy/i.test(name);
