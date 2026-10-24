// 生成应用图标源图（1024×1024 PNG）：深色圆角方底 + 白色 N 徽标。
// 纯 Node 实现（zlib 手写 PNG），无第三方依赖。
import zlib from 'node:zlib';
import fs from 'node:fs';

const S = 1024;
// Apple macOS 图标模板(Big Sur+):图稿 824² 居中,四周各留 100px 透明边,
// 圆角半径 ≈185(占图稿 22.5%)。铺满画布的图标在 Dock 里会比别家大一圈。
const A = 824;
const M = (S - A) / 2;
const R = 186;
// 品牌色：橙色圆角方底 + 黑色 N（用户提供的设计）
const BG = [238, 138, 92];
const FG = [17, 17, 17];

// 像素画布 RGBA
const px = new Uint8Array(S * S * 4);

function insideRounded(x, y) {
  // 圆角矩形内部判定(坐标换算到 824² 图稿内)
  const lx = x - M;
  const ly = y - M;
  if (lx < 0 || ly < 0 || lx >= A || ly >= A) return false;
  const rx = lx < R ? R - lx : lx >= A - R ? lx - (A - R - 1) : 0;
  const ry = ly < R ? R - ly : ly >= A - R ? ly - (A - R - 1) : 0;
  if (rx <= 0 || ry <= 0) return true;
  return rx * rx + ry * ry <= R * R;
}

// N 字形：左竖 + 右竖 + 对角线（按垂直距离取等粗笔画），坐标 0..1 相对字框。
// 对角线与竖笔等粗（用点到直线距离，而非竖直带），字形更匀称。
function insideN(lx, ly) {
  const u = lx / A;
  const v = ly / A;
  const x0 = 0.30, x1 = 0.70, y0 = 0.29, y1 = 0.71; // 字框
  if (u < x0 || u > x1 || v < y0 || v > y1) return false;
  const w = 0.068; // 竖笔宽
  if (u <= x0 + w || u >= x1 - w) return true;
  // 对角线：左竖顶端 → 右竖底端，垂直厚度与竖笔一致
  const ax = x0 + w, ay = y0, bx = x1 - w, by = y1;
  const dx = bx - ax, dy = by - ay;
  const dist = Math.abs((u - ax) * dy - (v - ay) * dx) / Math.hypot(dx, dy);
  return dist <= w / 2;
}

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    if (!insideRounded(x, y)) {
      px[i + 3] = 0; // 圆角外透明
      continue;
    }
    // 抗锯齿：3×3 子采样得到 N 的覆盖率，按覆盖率混合前景/背景
    let hit = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        if (insideN(x + dx / 2 - M, y + dy / 2 - M)) hit++;
    const a = hit / 9;
    px[i] = Math.round(BG[0] * (1 - a) + FG[0] * a);
    px[i + 1] = Math.round(BG[1] * (1 - a) + FG[1] * a);
    px[i + 2] = Math.round(BG[2] * (1 - a) + FG[2] * a);
    px[i + 3] = 255;
  }
}

// 编码 PNG（无滤波，zlib 压缩）
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter none
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const crcTable = [...Array(256)].map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.mkdirSync('apps/desktop/src-tauri/icons', { recursive: true });
fs.writeFileSync('apps/desktop/icon-source.png', png);
console.log('written apps/desktop/icon-source.png', png.length, 'bytes');
