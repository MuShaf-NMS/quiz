const ExcelJS = require('exceljs');

const LETTERS = 'ABCDEFGH'.split('');
const HEADERS = ['Event', 'Quiz', 'Sesi', 'Tipe', 'Soal', 'Gambar', 'Waktu', 'Poin', 'Pengurang', 'Bonus Kecepatan',
  ...LETTERS.map((l) => 'Pilihan ' + l), 'Jawaban Benar', 'Pilih Semua'];
const TYPES = { pilihan: 'mc', 'pilihan ganda': 'mc', mc: 'mc', rebutan: 'buzz', buzz: 'buzz', isian: 'text', text: 'text' };

async function template() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Soal', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(HEADERS);
  const ex = [
    ['Cerdas Cermat 2026', 'Babak Penyisihan', 'Sesi 1', 'Pilihan', 'Ibukota Indonesia?', '', 20, 1000, 0, 'ya', 'Bandung', 'Jakarta', 'Surabaya', 'Medan', '', '', '', '', 'B', 'tidak'],
    ['Cerdas Cermat 2026', 'Babak Penyisihan', 'Sesi 1', 'Pilihan', 'Pilih semua bilangan prima', '', 30, 1000, 500, 'ya', '2', '4', '5', '9', '', '', '', '', 'A,C', 'ya'],
    ['Cerdas Cermat 2026', 'Babak Rebutan', 'Sesi 1', 'Rebutan', 'Siapa proklamator Indonesia?', '', 15, 1500, 500, 'ya', '', '', '', '', '', '', '', '', 'Soekarno | Bung Karno', ''],
    ['Cerdas Cermat 2026', 'Babak Rebutan', 'Sesi 2', 'Isian', '10 x 10 = ?', '', 20, 1000, 0, 'tidak', '', '', '', '', '', '', '', '', '100|seratus', ''],
  ];
  ex.forEach((r) => ws.addRow(r));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF46178F' } };
  const widths = [22, 22, 16, 14, 44, 24, 8, 8, 10, 16, ...LETTERS.map(() => 16), 28, 12];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const list = (col, vals) => {
    for (let r = 2; r <= 500; r++) ws.getCell(col + r).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${vals}"`] };
  };
  list('D', 'Pilihan,Rebutan,Isian');
  list('J', 'ya,tidak');
  list('T', 'ya,tidak');

  const help = wb.addWorksheet('Petunjuk');
  help.getColumn(1).width = 22; help.getColumn(2).width = 100;
  [
    ['Sheet', 'Isi data soal di sheet "Soal", satu baris = satu soal. Hapus baris contoh sebelum dipakai.'],
    ['Event', 'Nama acara/kelompok. Event dibuat otomatis jika belum ada. Boleh dikosongkan (tanpa event).'],
    ['Quiz', 'Nama quiz di dalam event. Baris dengan Event+Quiz yang sama digabung jadi satu quiz. Jika quiz dengan nama itu sudah ada di event tersebut, isinya DIGANTI.'],
    ['Sesi', 'Opsional. Nama sesi/babak. Soal berurutan dengan Sesi yang sama dikelompokkan; di akhir tiap sesi (kecuali sesi terakhir) ditampilkan skor sementara, skor akhir hanya setelah sesi terakhir. Kosong = tanpa sesi.'],
    ['Tipe', 'Pilihan (pilihan ganda) / Rebutan (buzzer, host menilai) / Isian (ketik jawaban).'],
    ['Soal', 'Teks soal (wajib).'],
    ['Gambar', 'URL gambar (opsional).'],
    ['Waktu', 'Detik, 5-300. Kosong = 20.'],
    ['Poin', 'Poin jika benar. Kosong = 1000.'],
    ['Pengurang', 'Poin yang dikurangi jika salah. Kosong = 0.'],
    ['Bonus Kecepatan', 'ya/tidak. Kosong = ya. Jika ya, makin cepat menjawab makin banyak poin.'],
    ['Pilihan A-H', 'Khusus tipe Pilihan: isi minimal 2 pilihan. Kolom kosong dilewati.'],
    ['Jawaban Benar', 'Tipe Pilihan: huruf pilihan benar, pisahkan koma, contoh "B" atau "A,C". Tipe Isian/Rebutan: jawaban yang diterima, pisahkan dengan "|", contoh "100|seratus" (wajib untuk Isian, opsional untuk Rebutan).'],
    ['Pilih Semua', 'Khusus Pilihan dengan lebih dari satu jawaban benar: "ya" = pemain harus memilih SEMUA jawaban benar. Kosong = tidak.'],
  ].forEach((r) => help.addRow(r));
  help.getColumn(1).font = { bold: true };
  help.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function text(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('').trim();
    if (v.result != null) return String(v.result).trim();
    if (v.text != null) return String(v.text).trim();
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

// returns { groups: [{event, title, questions}], errors: [string] }
async function parse(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet('Soal') || wb.worksheets[0];
  if (!ws) return { groups: [], errors: ['Sheet tidak ditemukan'] };
  const col = {};
  ws.getRow(1).eachCell((c, n) => { col[text(c.value).toLowerCase()] = n; });
  for (const need of ['quiz', 'tipe', 'soal']) {
    if (!col[need]) return { groups: [], errors: [`Kolom "${need[0].toUpperCase() + need.slice(1)}" tidak ditemukan. Gunakan template.`] };
  }
  const get = (row, name) => (col[name] ? text(row.getCell(col[name]).value) : '');
  const groups = new Map();
  const errors = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    if (!row.values.some((v) => text(v) !== '')) return;
    const err = (m) => errors.push(`Baris ${n}: ${m}`);
    const type = TYPES[get(row, 'tipe').toLowerCase()];
    const q = { text: get(row, 'soal'), image: get(row, 'gambar') };
    if (!get(row, 'quiz')) return err('kolom Quiz kosong');
    if (!type) return err('Tipe harus Pilihan, Rebutan, atau Isian');
    if (!q.text) return err('Soal kosong');
    q.type = type; q.session = get(row, 'sesi');
    const num = (name, def) => { const s = get(row, name); if (s === '') return def; const v = Number(s); return Number.isFinite(v) ? v : NaN; };
    q.time = num('waktu', 20); q.points = num('poin', 1000); q.penalty = num('pengurang', 0);
    if ([q.time, q.points, q.penalty].some(Number.isNaN)) return err('Waktu/Poin/Pengurang harus angka');
    q.speedBonus = get(row, 'bonus kecepatan').toLowerCase() !== 'tidak';
    const ans = get(row, 'jawaban benar');
    if (type === 'mc') {
      const map = {};
      q.options = [];
      LETTERS.forEach((l) => { const o = get(row, 'pilihan ' + l.toLowerCase()); if (o) { map[l] = q.options.length; q.options.push(o); } });
      if (q.options.length < 2) return err('Tipe Pilihan butuh minimal 2 pilihan');
      const keys = ans.toUpperCase().split(/[,;\s]+/).filter(Boolean);
      if (!keys.length) return err('Jawaban Benar kosong');
      if (keys.some((k) => map[k] === undefined)) return err(`Jawaban Benar "${ans}" tidak cocok dengan pilihan yang terisi`);
      q.correct = [...new Set(keys.map((k) => map[k]))];
      q.multi = q.correct.length > 1 && get(row, 'pilih semua').toLowerCase() === 'ya';
    } else {
      q.accepted = ans.split('|').map((s) => s.trim()).filter(Boolean);
      if (type === 'text' && !q.accepted.length) return err('Tipe Isian butuh Jawaban Benar');
    }
    const event = get(row, 'event'), title = get(row, 'quiz');
    const key = event.toLowerCase() + '\u0000' + title.toLowerCase();
    if (!groups.has(key)) groups.set(key, { event, title, questions: [] });
    groups.get(key).questions.push(q);
  });
  if (!groups.size && !errors.length) errors.push('Tidak ada baris soal yang ditemukan');
  return { groups: [...groups.values()], errors };
}

// totals per player across games (case-insensitive name), plus per-game columns
function aggregate(games) {
  const titles = games.map((g, i) => (games.filter((o) => o.quiz_title === g.quiz_title).length > 1
    ? `${g.quiz_title} (${games.slice(0, i + 1).filter((o) => o.quiz_title === g.quiz_title).length})` : g.quiz_title));
  const map = new Map();
  games.forEach((g, gi) => g.results.forEach((r) => {
    const k = r.name.toLowerCase();
    if (!map.has(k)) map.set(k, { name: r.name, total: 0, correct: 0, wrong: 0, perGame: games.map(() => null) });
    const e = map.get(k);
    e.total += r.score; e.correct += r.correct || 0; e.wrong += r.wrong || 0; e.perGame[gi] = r.score;
  }));
  const totals = [...map.values()].sort((a, b) => b.total - a.total).map((e, i) => ({ rank: i + 1, ...e }));
  return {
    games: games.map((g, i) => ({ id: g.id, title: titles[i], played_at: g.played_at, finished: g.finished,
      players: g.results.length, answered: g.answered_questions, total: g.total_questions })),
    totals,
  };
}

function style(ws, widths) {
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF46178F' } };
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}
const fmt = (d) => new Date(d).toLocaleString('id-ID', { timeZone: process.env.TZ || 'Asia/Jakarta' });

async function exportEvent(ev, games) {
  const a = aggregate(games);
  const wb = new ExcelJS.Workbook();
  const t = wb.addWorksheet('Total');
  t.addRow(['Peringkat', 'Nama', 'Total Skor', ...a.games.map((g) => g.title), 'Benar', 'Salah']);
  a.totals.forEach((p) => t.addRow([p.rank, p.name, p.total, ...p.perGame.map((v) => (v == null ? '' : v)), p.correct, p.wrong]));
  style(t, [11, 24, 12, ...a.games.map(() => 18), 8, 8]);
  const d = wb.addWorksheet('Detail');
  d.addRow(['Event', 'Quiz', 'Waktu', 'Status', 'Peringkat', 'Nama', 'Skor', 'Benar', 'Salah']);
  games.forEach((g, i) => g.results.forEach((r) => d.addRow([ev.name, a.games[i].title, fmt(g.played_at),
    g.finished ? 'Selesai' : `Belum selesai (${g.answered_questions}/${g.total_questions} soal)`, r.rank, r.name, r.score, r.correct || 0, r.wrong || 0])));
  style(d, [22, 22, 20, 26, 11, 24, 10, 8, 8]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function exportGame(g) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hasil');
  ws.addRow(['Peringkat', 'Nama', 'Skor', 'Benar', 'Salah']);
  g.results.forEach((r) => ws.addRow([r.rank, r.name, r.score, r.correct || 0, r.wrong || 0]));
  style(ws, [11, 24, 10, 8, 8]);
  ws.addRow([]);
  ws.addRow(['Event', g.event_name || '-']);
  ws.addRow(['Quiz', g.quiz_title]);
  ws.addRow(['Waktu', fmt(g.played_at)]);
  ws.addRow(['Status', g.finished ? 'Selesai' : `Belum selesai (${g.answered_questions}/${g.total_questions} soal)`]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { template, parse, aggregate, exportEvent, exportGame };
