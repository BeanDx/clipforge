// Шифр ICE (Matthew Kwan, общественное достояние). Valve шифрует им голосовой чат в демках матчмейкинга;
// ключ лежит в .dem.info рядом с демкой (WatchableMatchInfo.cl_decryptdata_key_pub).

const SMOD: [[u32; 4]; 4] = [[333, 313, 505, 369], [379, 375, 319, 391], [361, 445, 451, 397], [397, 425, 395, 505]];
const SXOR: [[u32; 4]; 4] = [[0x83, 0x85, 0x9b, 0xcd], [0xcc, 0xa7, 0xad, 0x41], [0x4b, 0x2e, 0xd4, 0x33], [0xea, 0xcb, 0x2e, 0x04]];
const PBOX: [u32; 32] = [
    0x00000001, 0x00000080, 0x00000400, 0x00002000, 0x00080000, 0x00200000, 0x01000000, 0x40000000,
    0x00000008, 0x00000020, 0x00000100, 0x00004000, 0x00010000, 0x00800000, 0x04000000, 0x20000000,
    0x00000004, 0x00000010, 0x00000200, 0x00008000, 0x00020000, 0x00400000, 0x08000000, 0x10000000,
    0x00000002, 0x00000040, 0x00000800, 0x00001000, 0x00040000, 0x00100000, 0x02000000, 0x80000000,
];
const KEYROT: [usize; 16] = [0, 1, 2, 3, 2, 1, 3, 0, 1, 3, 2, 0, 3, 1, 0, 2];

fn gf_mult(mut a: u32, mut b: u32, m: u32) -> u32 {
    let mut res = 0;
    while b != 0 {
        if b & 1 != 0 { res ^= a; }
        a <<= 1;
        b >>= 1;
        if a >= 256 { a ^= m; }
    }
    res
}

fn gf_exp7(b: u32, m: u32) -> u32 {
    if b == 0 { return 0; }
    let mut x = gf_mult(b, b, m);
    x = gf_mult(b, x, m);
    x = gf_mult(x, x, m);
    gf_mult(b, x, m)
}

fn perm32(mut x: u32) -> u32 {
    let (mut res, mut i) = (0, 0);
    while x != 0 {
        if x & 1 != 0 { res |= PBOX[i]; }
        i += 1;
        x >>= 1;
    }
    res
}

pub struct Ice {
    sbox: Box<[[u32; 1024]; 4]>,
    sched: Vec<[u32; 3]>,
}

impl Ice {
    // level 2: ключ 16 байт, 32 раунда (так в CS)
    pub fn new(level: usize, key: &[u8]) -> Ice {
        let mut sbox = Box::new([[0u32; 1024]; 4]);
        for i in 0..1024u32 {
            let col = (i >> 1) & 0xff;
            let row = ((i & 1) | ((i & 0x200) >> 8)) as usize;
            sbox[0][i as usize] = perm32(gf_exp7(col ^ SXOR[0][row], SMOD[0][row]) << 24);
            sbox[1][i as usize] = perm32(gf_exp7(col ^ SXOR[1][row], SMOD[1][row]) << 16);
            sbox[2][i as usize] = perm32(gf_exp7(col ^ SXOR[2][row], SMOD[2][row]) << 8);
            sbox[3][i as usize] = perm32(gf_exp7(col ^ SXOR[3][row], SMOD[3][row]));
        }
        let (size, rounds) = if level < 1 { (1, 8) } else { (level, level * 16) };
        let mut ice = Ice { sbox, sched: vec![[0; 3]; rounds] };
        if rounds == 8 {
            let mut kb = [0u16; 4];
            for i in 0..4 { kb[3 - i] = ((key[i * 2] as u16) << 8) | key[i * 2 + 1] as u16; }
            ice.build(&mut kb, 0, &KEYROT[..8]);
        } else {
            for i in 0..size {
                let mut kb = [0u16; 4];
                for j in 0..4 { kb[3 - j] = ((key[i * 8 + j * 2] as u16) << 8) | key[i * 8 + j * 2 + 1] as u16; }
                ice.build(&mut kb, i * 8, &KEYROT[..8]);
                ice.build(&mut kb, rounds - 8 - i * 8, &KEYROT[8..]);
            }
        }
        ice
    }

    fn build(&mut self, kb: &mut [u16; 4], n: usize, keyrot: &[usize]) {
        for (i, &kr) in keyrot.iter().enumerate().take(8) {
            let isk = &mut self.sched[n + i];
            *isk = [0; 3];
            for j in 0..15 {
                for k in 0..4 {
                    let cb = &mut kb[(kr + k) & 3];
                    let bit = (*cb & 1) as u32;
                    isk[j % 3] = (isk[j % 3] << 1) | bit;
                    *cb = (*cb >> 1) | (((bit ^ 1) as u16) << 15);
                }
            }
        }
    }

    fn f(&self, p: u32, sk: &[u32; 3]) -> u32 {
        let tl = ((p >> 16) & 0x3ff) | (((p >> 14) | (p << 18)) & 0xffc00);
        let tr = (p & 0x3ff) | ((p << 2) & 0xffc00);
        let mut al = sk[2] & (tl ^ tr);
        let mut ar = al ^ tr;
        al ^= tl;
        al ^= sk[0];
        ar ^= sk[1];
        self.sbox[0][(al >> 10) as usize] | self.sbox[1][(al & 0x3ff) as usize]
            | self.sbox[2][(ar >> 10) as usize] | self.sbox[3][(ar & 0x3ff) as usize]
    }

    fn decrypt_block(&self, b: &mut [u8]) {
        let mut l = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        let mut r = u32::from_be_bytes([b[4], b[5], b[6], b[7]]);
        let mut i = self.sched.len() - 1;
        loop {
            l ^= self.f(r, &self.sched[i]);
            r ^= self.f(l, &self.sched[i - 1]);
            if i < 3 { break; }
            i -= 2;
        }
        b[..4].copy_from_slice(&r.to_be_bytes());
        b[4..8].copy_from_slice(&l.to_be_bytes());
    }

    // целые 8-байтовые блоки расшифровываются, хвост остаётся как есть (как в движке Source)
    pub fn decrypt(&self, data: &mut [u8]) {
        for c in data.chunks_exact_mut(8) { self.decrypt_block(c); }
    }
}
