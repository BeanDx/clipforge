// Сжимает карту, выгруженную Source 2 Viewer (glb, сотни МБ: UV, тангенты, цвета), в простой
// бинарный файл для 3D-превью: только позиции и нормали, уже в координатах Source (дюймы, z вверх),
// все меши слиты в один. Читает его src/features/scene3d/engine.js.
// argv: <in.glb> <out.bin>
// Формат: "S3D1", uint32 вершин, uint32 индексов, uint32 0; float32[3V] позиции; int8[4V] нормали;
// uint32[I] индексы.
const fs = require("fs");

const K = 1 / 0.0254; // glTF Source 2 Viewer — метры и (y, z, x) от осей Source

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function trs(n) {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation || [0, 0, 0];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale || [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

try {
  const [inp, out] = process.argv.slice(2);
  const b = fs.readFileSync(inp);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error("не glb");
  const jlen = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + jlen).toString("utf8"));
  const binStart = 20 + jlen + 8;
  const bin = b.subarray(binStart, binStart + b.readUInt32LE(20 + jlen));

  const view = (acc) => {
    const bv = j.bufferViews[acc.bufferView];
    return { off: (bv.byteOffset || 0) + (acc.byteOffset || 0), stride: bv.byteStride || 0 };
  };
  const readIndex = (acc) => {
    const { off } = view(acc);
    const n = acc.count;
    if (acc.componentType === 5125) return new Uint32Array(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + n * 4));
    if (acc.componentType === 5123) return Uint32Array.from(new Uint16Array(bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + n * 2)));
    if (acc.componentType === 5121) return Uint32Array.from(bin.subarray(off, off + n));
    throw new Error("индексы " + acc.componentType);
  };

  // мировые матрицы узлов
  const world = new Array(j.nodes.length);
  const walk = (i, parent) => {
    world[i] = parent ? mul(parent, trs(j.nodes[i])) : trs(j.nodes[i]);
    for (const c of j.nodes[i].children || []) walk(c, world[i]);
  };
  for (const r of j.scenes[j.scene || 0].nodes) walk(r, null);

  const P = [], N = [], I = [];
  let base = 0;
  for (let ni = 0; ni < j.nodes.length; ni++) {
    const node = j.nodes[ni];
    if (node.mesh == null || !world[ni]) continue;
    const m = world[ni];
    // нормали: обратная транспонированная 3x3 (для поворотов и равномерного масштаба хватает самой матрицы)
    for (const prim of j.meshes[node.mesh].primitives) {
      if (prim.mode != null && prim.mode !== 4) continue;
      const pa = j.accessors[prim.attributes.POSITION];
      if (!pa || pa.componentType !== 5126) continue;
      const na = prim.attributes.NORMAL != null ? j.accessors[prim.attributes.NORMAL] : null;
      const idx = prim.indices != null ? readIndex(j.accessors[prim.indices]) : Uint32Array.from({ length: pa.count }, (_, i) => i);
      const pv = view(pa), nv = na && na.componentType === 5126 ? view(na) : null;
      const remap = new Map();
      for (let k = 0; k < idx.length; k++) {
        const v = idx[k];
        let r = remap.get(v);
        if (r === undefined) {
          r = base + remap.size;
          remap.set(v, r);
          const po = pv.off + v * (pv.stride || 12);
          const x = bin.readFloatLE(po), y = bin.readFloatLE(po + 4), z = bin.readFloatLE(po + 8);
          const gx = m[0] * x + m[4] * y + m[8] * z + m[12];
          const gy = m[1] * x + m[5] * y + m[9] * z + m[13];
          const gz = m[2] * x + m[6] * y + m[10] * z + m[14];
          P.push(gz * K, gx * K, gy * K);
          if (nv) {
            const no = nv.off + v * (nv.stride || 12);
            const a = bin.readFloatLE(no), bb = bin.readFloatLE(no + 4), c = bin.readFloatLE(no + 8);
            let hx = m[0] * a + m[4] * bb + m[8] * c, hy = m[1] * a + m[5] * bb + m[9] * c, hz = m[2] * a + m[6] * bb + m[10] * c;
            const l = Math.hypot(hx, hy, hz) || 1;
            hx /= l; hy /= l; hz /= l;
            N.push(Math.round(hz * 127), Math.round(hx * 127), Math.round(hy * 127), 0);
          } else N.push(0, 0, 127, 0);
        }
        I.push(r);
      }
      base += remap.size;
    }
  }

  const V = P.length / 3;
  const head = Buffer.alloc(16);
  head.write("S3D1", 0, "ascii");
  head.writeUInt32LE(V, 4);
  head.writeUInt32LE(I.length, 8);
  const fd = fs.openSync(out + ".tmp", "w");
  fs.writeSync(fd, head);
  fs.writeSync(fd, Buffer.from(Float32Array.from(P).buffer));
  fs.writeSync(fd, Buffer.from(Int8Array.from(N).buffer));
  fs.writeSync(fd, Buffer.from(Uint32Array.from(I).buffer));
  fs.closeSync(fd);
  fs.renameSync(out + ".tmp", out);
  process.stdout.write(JSON.stringify({ vertices: V, triangles: I.length / 3 }));
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(1);
}
