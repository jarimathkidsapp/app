/**
 * ============================================================
 *  JARIMATH KIDS — Portal Admin, Guru & Orang Tua
 *  Backend: Google Apps Script + Google Spreadsheet
 * ============================================================
 *  Cara pakai singkat (detail di PANDUAN.md):
 *  1. Google Spreadsheet → Extensions → Apps Script.
 *  2. Tempel file ini ke Code.gs, buat file HTML bernama "index"
 *     lalu tempel isi index.html.
 *  3. Jalankan fungsi setup() sekali (izinkan akses).
 *  4. Deploy → New deployment → Web app
 *       Execute as: Me | Who has access: Anyone
 *     (setiap ubah kode: Manage deployments → Edit → New version)
 *  5. Buka URL /exec → login admin: admin / jarimath123 (segera ganti).
 * ============================================================
 */

// Kosongkan jika script dibuat dari dalam spreadsheet (Extensions → Apps Script).
const SS_ID = '';
const SESSION_SECONDS = 21600; // 6 jam
const TZ = 'Asia/Jakarta';

// Kolom baru selalu DITAMBAH DI BELAKANG agar sheet lama tetap cocok.
const SCHEMA = {
  Pengaturan:   ['key', 'value'],
  Users:        ['id', 'username', 'passwordHash', 'nama', 'role'],
  Siswa:        ['id', 'nama', 'panggilan', 'jk', 'tglLahir', 'ortu', 'waOrtu', 'alamat', 'tglMulai', 'level', 'status', 'sppNominal', 'pin', 'kodeOrtu', 'catatan'],
  Guru:         ['id', 'nama', 'wa', 'status', 'catatan', 'pin', 'tipeTarif', 'tarif'],
  Jadwal:       ['id', 'hari', 'sesi', 'jamMulai', 'jamSelesai', 'tipe', 'guruId', 'siswaIds', 'catatan'],
  Absensi:      ['id', 'tanggal', 'siswaId', 'status', 'guruId', 'catatan'],
  AbsensiGuru:  ['id', 'tanggal', 'guruId', 'status', 'jamMasuk', 'jamKeluar', 'jamMengajar', 'catatan'],
  Perkembangan: ['id', 'tanggal', 'siswaId', 'guruId', 'jurus', 'deskripsi'],
  SPP:          ['id', 'noInvoice', 'siswaId', 'periode', 'nominal', 'tanggalBayar', 'metode', 'catatan'],
  Gaji:         ['id', 'guruId', 'periode', 'bonus', 'potongan', 'catatan', 'tanggalBayar', 'total'],
  Laporan:      ['id', 'siswaId', 'periode', 'level', 'hadir', 'pertemuan', 'rataNilai', 'bintang', 'pencapaian', 'catatanGuru', 'dibuat'],
  Nilai:        ['id', 'siswaId', 'tanggal', 'level', 'benar', 'total', 'skor', 'durasi', 'bintang'],
  Bintang:      ['id', 'siswaId', 'tanggal', 'jumlah', 'tipe', 'keterangan'],
  Soal:         ['id', 'level', 'soal', 'jawaban', 'aktif', 'jurus']
};
// Kunci unik: satu baris per kombinasi ini (mencegah data dobel)
const UNIQUE = {
  Absensi: ['tanggal', 'siswaId'],
  AbsensiGuru: ['tanggal', 'guruId'],
  SPP: ['siswaId', 'periode'],
  Laporan: ['siswaId', 'periode'],
  Gaji: ['guruId', 'periode']
};
const ADMIN_TABLES = ['Siswa', 'Guru', 'Jadwal', 'Absensi', 'AbsensiGuru', 'Perkembangan', 'SPP', 'Gaji', 'Laporan', 'Nilai', 'Bintang', 'Soal'];

const DEFAULT_LEVELS = JSON.stringify([
  { n: 1, nama: 'Jurus 0', desc: 'Pengenalan jari & jurus 0', jurus: 'Jurus 0' },
  { n: 2, nama: 'Teman Kecil', desc: 'Jurus 1 & 2 — Teman Kecil', jurus: 'Jurus 1, Jurus 2' },
  { n: 3, nama: 'Teman Besar', desc: 'Jurus 3 & 4 — Teman Besar', jurus: 'Jurus 3, Jurus 4' },
  { n: 4, nama: 'Ratusan & Tempel Lempar', desc: 'Ratusan, Jurus 5 & 6 — Tempel Lempar', jurus: 'Ratusan, Jurus 5, Jurus 6' }
]);
const DEFAULT_SETTINGS = {
  namaLembaga: 'JariMath Kids',
  tagline: 'Berhitung Cepat dengan Jari Tangan',
  alamat: 'Alamat lembaga',
  noWa: '081234567890',
  nominalSPP: '150000',
  jatuhTempo: '10',
  tahunAjaran: '2026/2027',
  rekening: 'BCA 1234567890 a.n. JariMath Kids',
  pertemuanPerBulan: '8',
  portalUrl: '',
  soalPerLatihan: '10',
  levels: DEFAULT_LEVELS
};

/* ---------------- ENTRY POINTS ---------------- */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('JariMath Kids — Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  let res;
  try { res = route_(JSON.parse(e.postData.contents)); }
  catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

function api(reqJson) {
  try { return JSON.stringify(route_(JSON.parse(reqJson))); }
  catch (err) { return JSON.stringify({ ok: false, error: String(err && err.message || err) }); }
}

/* ---------------- ROUTER ---------------- */

function route_(req) {
  const a = req.action;
  if (a === 'ping') return { ok: true, time: new Date().toISOString() };
  if (a === 'login') return login_(req);
  if (a === 'publicSettings') return { ok: true, settings: publicSettings_() };

  const s = getSession_(req.token);
  if (!s) return { ok: false, error: 'SESSION', message: 'Sesi berakhir, silakan login kembali.' };
  if (a === 'logout') { CacheService.getScriptCache().remove('s_' + req.token); return { ok: true }; }

  if (s.role === 'admin') {
    switch (a) {
      case 'bootstrap':      return { ok: true, data: bootstrap_() };
      case 'save':           checkTable_(req.table); return { ok: true, row: withLock_(() => upsertMany_(req.table, [req.row])[0]) };
      case 'saveMany':       checkTable_(req.table); return { ok: true, rows: withLock_(() => upsertMany_(req.table, req.rows || [])) };
      case 'remove':         checkTable_(req.table); withLock_(() => removeRow_(req.table, req.id)); return { ok: true };
      case 'saveSettings':   withLock_(() => saveSettings_(req.settings || {})); return { ok: true, settings: getSettings_() };
      case 'changePassword': return changePassword_(s, req);
    }
  }
  if (s.role === 'guru') {
    switch (a) {
      case 'guruData':          return { ok: true, data: guruData_(s) };
      case 'guruAbsen':         return { ok: true, row: withLock_(() => guruAbsen_(s, req)) };
      case 'guruSaveAbsensi':   return { ok: true, rows: withLock_(() => guruSaveAbsensi_(s, req.rows || [])) };
      case 'guruSaveProgress':  return { ok: true, rows: withLock_(() => guruSaveProgress_(s, req.rows || [])) };
      case 'guruDelProgress':   withLock_(() => guruDelProgress_(s, req.id)); return { ok: true };
    }
  }
  if (s.role === 'ortu') {
    if (a === 'me') return { ok: true, data: me_(s) };
    if (a === 'submitQuiz') return { ok: true, result: withLock_(() => submitQuiz_(s, req)) };
  }
  return { ok: false, error: 'Akses ditolak' };
}

/* ---------------- AUTH ---------------- */

function login_(req) {
  const role = String(req.role || '');
  const user = String(req.user || '').trim();
  const pass = String(req.pass || '').trim();
  if (!user || !pass) return { ok: false, error: 'Lengkapi data login.' };

  let profile = null;
  if (role === 'admin') {
    const u = readTable_('Users').find(r => r.username.toLowerCase() === user.toLowerCase());
    if (u && u.passwordHash === hash_(pass)) profile = { id: u.id, nama: u.nama, username: u.username };
  } else if (role === 'guru') {
    lengkapiDataGuru();
    const g = readTable_('Guru').find(r => r.id.toUpperCase() === user.toUpperCase());
    if (g && String(g.pin) === pass && g.status !== 'Nonaktif') profile = { id: g.id, nama: g.nama };
  } else if (role === 'ortu') {
    lengkapiDataSiswa();
    const s = readTable_('Siswa').find(r => r.id.toUpperCase() === user.toUpperCase());
    if (s && String(s.kodeOrtu) === pass && s.status !== 'Berhenti') profile = { id: s.id, nama: s.nama, panggilan: s.panggilan };
  }
  if (!profile) return { ok: false, error: role === 'admin' ? 'Username atau password salah.' : role === 'guru' ? 'ID guru atau PIN salah.' : 'ID siswa atau kode akses salah.' };

  const token = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('s_' + token, JSON.stringify({ role: role, uid: profile.id }), SESSION_SECONDS);
  return { ok: true, token: token, role: role, profile: profile };
}

function getSession_(token) {
  if (!token) return null;
  const v = CacheService.getScriptCache().get('s_' + token);
  if (!v) return null;
  CacheService.getScriptCache().put('s_' + token, v, SESSION_SECONDS);
  return JSON.parse(v);
}

function changePassword_(s, req) {
  const u = readTable_('Users').find(r => r.id === s.uid);
  if (!u || u.passwordHash !== hash_(String(req.oldPass || ''))) return { ok: false, error: 'Password lama salah.' };
  if (String(req.newPass || '').length < 6) return { ok: false, error: 'Password baru minimal 6 karakter.' };
  u.passwordHash = hash_(String(req.newPass));
  withLock_(() => upsertMany_('Users', [u]));
  return { ok: true };
}

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

const today_ = () => Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
const nowHM_ = () => Utilities.formatDate(new Date(), TZ, 'HH:mm');

/* ---------------- ADMIN ---------------- */

function bootstrap_() {
  lengkapiDataSiswa();
  lengkapiDataGuru();
  withLock_(() => Object.keys(UNIQUE).forEach(bersihkanDobel_));
  const db = {};
  ADMIN_TABLES.forEach(t => db[t] = readTable_(t));
  return { db: db, settings: getSettings_() };
}

/* ---------------- GURU ---------------- */

function guruData_(s) {
  const g = readTable_('Guru').find(r => r.id === s.uid);
  if (!g) throw new Error('Data guru tidak ditemukan');
  const jadwal = readTable_('Jadwal').filter(j => j.guruId === s.uid);
  const diajar = {};
  jadwal.forEach(j => String(j.siswaIds).split(',').forEach(x => { if (x.trim()) diajar[x.trim()] = 1; }));
  const siswa = readTable_('Siswa').filter(x => x.status === 'Aktif')
    .map(x => ({ id: x.id, nama: x.nama, panggilan: x.panggilan, jk: x.jk, level: x.level, tglLahir: x.tglLahir, diajar: diajar[x.id] ? '1' : '' }));
  const cutoff = Utilities.formatDate(new Date(Date.now() - 62 * 864e5), TZ, 'yyyy-MM-dd');
  const safe = Object.assign({}, g); delete safe.pin; delete safe.tarif; delete safe.tipeTarif;
  return {
    guru: safe,
    settings: publicSettings_(),
    siswa: siswa,
    Jadwal: jadwal,
    Absensi: readTable_('Absensi').filter(r => r.tanggal >= cutoff),
    AbsensiGuru: readTable_('AbsensiGuru').filter(r => r.guruId === s.uid),
    Perkembangan: readTable_('Perkembangan').filter(r => r.tanggal >= cutoff && (r.guruId === s.uid || diajar[r.siswaId]))
  };
}

function guruAbsen_(s, req) {
  const tgl = today_();
  const row = readTable_('AbsensiGuru').find(r => r.guruId === s.uid && r.tanggal === tgl) || { tanggal: tgl, guruId: s.uid, status: '', jamMasuk: '', jamKeluar: '', jamMengajar: '', catatan: '' };
  const mode = req.mode;
  if (mode === 'masuk') { row.status = 'Hadir'; if (!row.jamMasuk) row.jamMasuk = nowHM_(); }
  else if (mode === 'pulang') {
    row.status = 'Hadir'; if (!row.jamMasuk) row.jamMasuk = nowHM_();
    row.jamKeluar = nowHM_();
    const a = row.jamMasuk.split(':').map(Number), b = row.jamKeluar.split(':').map(Number);
    const d = ((b[0] * 60 + b[1]) - (a[0] * 60 + a[1])) / 60;
    row.jamMengajar = d > 0 ? String(Math.round(d * 2) / 2) : '0';
  } else if (mode === 'Izin' || mode === 'Sakit') { row.status = mode; row.jamMengajar = '0'; }
  if (req.catatan != null) row.catatan = String(req.catatan);
  return upsertMany_('AbsensiGuru', [row])[0];
}

function guruSaveAbsensi_(s, rows) {
  const aktif = {}; readTable_('Siswa').forEach(x => { if (x.status === 'Aktif') aktif[x.id] = 1; });
  const existing = readTable_('Absensi');
  const out = rows.filter(r => aktif[r.siswaId] && /^\d{4}-\d{2}-\d{2}$/.test(r.tanggal) && ['Hadir', 'Izin', 'Sakit', 'Alpa'].indexOf(r.status) > -1)
    .map(r => {
      const ex = existing.find(e => e.tanggal === r.tanggal && e.siswaId === r.siswaId);
      return { id: ex ? ex.id : '', tanggal: r.tanggal, siswaId: r.siswaId, status: r.status, guruId: s.uid, catatan: String(r.catatan || '') };
    });
  out.forEach(r => { if (!r.id) delete r.id; });
  return upsertMany_('Absensi', out);
}

function guruSaveProgress_(s, rows) {
  const aktif = {}; readTable_('Siswa').forEach(x => { if (x.status === 'Aktif') aktif[x.id] = 1; });
  const existing = readTable_('Perkembangan');
  const out = rows.filter(r => aktif[r.siswaId] && String(r.deskripsi || '').trim()).map(r => {
    const ex = r.id ? existing.find(e => e.id === r.id && e.guruId === s.uid) : null;
    const o = { tanggal: r.tanggal || today_(), siswaId: r.siswaId, guruId: s.uid, jurus: String(r.jurus || ''), deskripsi: String(r.deskripsi).trim() };
    if (ex) o.id = ex.id;
    return o;
  });
  return upsertMany_('Perkembangan', out);
}

function guruDelProgress_(s, id) {
  const ex = readTable_('Perkembangan').find(e => e.id === id && e.guruId === s.uid);
  if (ex) removeRow_('Perkembangan', id);
}

/* ---------------- ORANG TUA ---------------- */

function me_(s) {
  const siswa = readTable_('Siswa').find(r => r.id === s.uid);
  if (!siswa) throw new Error('Data siswa tidak ditemukan');
  const mine = t => readTable_(t).filter(r => r.siswaId === s.uid);
  const guru = readTable_('Guru');
  const gNama = id => { const g = guru.find(x => x.id === id); return g ? g.nama : ''; };
  const jadwal = readTable_('Jadwal')
    .filter(j => String(j.siswaIds).split(',').map(x => x.trim()).indexOf(s.uid) > -1)
    .map(j => Object.assign({}, j, { guruNama: gNama(j.guruId) }));
  const lv = Number(siswa.level) || 1;
  const safe = Object.assign({}, siswa); delete safe.pin; delete safe.kodeOrtu;
  return {
    role: 'ortu',
    siswa: safe,
    settings: publicSettings_(),
    Absensi: mine('Absensi'),
    SPP: mine('SPP'),
    Laporan: mine('Laporan'),
    Perkembangan: mine('Perkembangan').map(p => Object.assign({}, p, { guruNama: gNama(p.guruId) })),
    Nilai: mine('Nilai'),
    Bintang: mine('Bintang'),
    Jadwal: jadwal,
    Soal: readTable_('Soal').filter(q => q.aktif !== 'Tidak' && Number(q.level) <= lv)
  };
}

function submitQuiz_(s, req) {
  const siswa = readTable_('Siswa').find(r => r.id === s.uid);
  const level = Math.max(1, Math.min(4, Number(req.level) || 1));
  if (level > (Number(siswa.level) || 1)) throw new Error('Level ini belum terbuka.');
  const total = Math.max(1, Math.min(100, Number(req.total) || 10));
  const benar = Math.max(0, Math.min(total, Number(req.benar) || 0));
  const skor = Math.round(benar / total * 100);
  const bintang = skor >= 90 ? 3 : skor >= 75 ? 2 : skor >= 60 ? 1 : 0;
  const tgl = today_();
  upsertMany_('Nilai', [{ siswaId: s.uid, tanggal: tgl, level: level, benar: benar, total: total, skor: skor, durasi: Number(req.durasi) || 0, bintang: bintang }]);
  if (bintang > 0) upsertMany_('Bintang', [{ siswaId: s.uid, tanggal: tgl, jumlah: bintang, tipe: 'Latihan', keterangan: 'Latihan Level ' + level + (req.jurus ? ' · ' + req.jurus : '') + ' (skor ' + skor + ')' }]);
  return { skor: skor, bintang: bintang };
}

/* ---------------- SETTINGS ---------------- */

function getSettings_() {
  const o = Object.assign({}, DEFAULT_SETTINGS);
  readTable_('Pengaturan').forEach(r => { if (r.key) o[r.key] = r.value; });
  return o;
}
function publicSettings_() {
  const s = getSettings_();
  const keys = ['namaLembaga', 'tagline', 'alamat', 'noWa', 'rekening', 'jatuhTempo', 'nominalSPP', 'tahunAjaran', 'portalUrl', 'soalPerLatihan', 'levels'];
  const o = {}; keys.forEach(k => o[k] = s[k]); return o;
}
function saveSettings_(obj) {
  const sh = sheet_('Pengaturan');
  const cur = getSettings_();
  Object.keys(obj).forEach(k => cur[k] = obj[k]);
  const rows = Object.keys(cur).map(k => [k, String(cur[k])]);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 2).clearContent();
  sh.getRange(2, 1, rows.length, 2).setNumberFormat('@').setValues(rows);
}

/* ---------------- SHEET HELPERS ---------------- */

function ss_() { return SS_ID ? SpreadsheetApp.openById(SS_ID) : SpreadsheetApp.getActiveSpreadsheet(); }

const _checked = {};
function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  const h = SCHEMA[name];
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#E31183').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), h.length).setNumberFormat('@');
  } else if (!_checked[name]) {
    // migrasi: tambahkan kolom baru di belakang bila sheet lama
    const cur = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getDisplayValues()[0].filter(String);
    if (cur.length < h.length) {
      sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#E31183').setFontColor('#FFFFFF');
      sh.getRange(1, cur.length + 1, sh.getMaxRows(), h.length - cur.length).setNumberFormat('@');
    }
  }
  _checked[name] = 1;
  return sh;
}

function checkTable_(t) { if (ADMIN_TABLES.indexOf(t) < 0) throw new Error('Tabel tidak dikenal: ' + t); }

function readTable_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const h = SCHEMA[name];
  return sh.getRange(2, 1, last - 1, h.length).getDisplayValues()
    .filter(r => r[0] !== '')
    .map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; });
}

function newId_(name, existing) {
  const seq = (prefix, digits) => {
    let max = 0;
    existing.forEach(r => { const m = String(r.id).match(new RegExp('^' + prefix + '(\\d+)$')); if (m && +m[1] > max) max = +m[1]; });
    return prefix + String(max + 1).padStart(digits, '0');
  };
  if (name === 'Siswa') return seq('JMK', 3);
  if (name === 'Guru') return seq('G', 2);
  return name.slice(0, 2).toUpperCase() + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function upsertMany_(name, rows) {
  const sh = sheet_(name);
  const h = SCHEMA[name];
  const existing = readTable_(name);
  const idx = {}; existing.forEach((r, i) => idx[r.id] = i + 2);
  const uk = UNIQUE[name];
  const keyOf = r => uk.map(k => String(r[k] == null ? '' : r[k])).join('|');
  const byKey = {};
  if (uk) {
    existing.forEach(r => byKey[keyOf(r)] = r.id);
    const last = {}; rows.forEach((r, i) => last[keyOf(r)] = i);       // dalam satu kiriman: yang terakhir menang
    rows = rows.filter((r, i) => last[keyOf(r)] === i);
  }
  const out = [], appends = [];
  rows.forEach(row => {
    const r = Object.assign({}, row);
    if (uk && (!r.id || !idx[r.id]) && byKey[keyOf(r)]) r.id = byKey[keyOf(r)];
    if (!r.id || !idx[r.id]) {
      if (!r.id) r.id = newId_(name, existing.concat(out));
      if (name === 'SPP' && !r.noInvoice) r.noInvoice = 'INV-' + String(r.periode).replace('-', '') + '-' + r.siswaId;
      appends.push(h.map(k => r[k] == null ? '' : String(r[k])));
    } else {
      const old = existing[idx[r.id] - 2];
      const merged = Object.assign({}, old, r);
      Object.assign(r, merged);
      sh.getRange(idx[r.id], 1, 1, h.length).setNumberFormat('@').setValues([h.map(k => r[k] == null ? '' : String(r[k]))]);
    }
    const clean = {}; h.forEach(k => clean[k] = r[k] == null ? '' : String(r[k]));
    out.push(clean);
  });
  if (appends.length) {
    const start = Math.max(sh.getLastRow(), 1) + 1;
    sh.getRange(start, 1, appends.length, h.length).setNumberFormat('@').setValues(appends);
  }
  return out;
}

function removeRow_(name, id) {
  const sh = sheet_(name);
  const ids = sh.getRange(1, 1, sh.getLastRow(), 1).getDisplayValues().map(r => r[0]);
  const i = ids.indexOf(String(id));
  if (i > 0) sh.deleteRow(i + 1);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* Hapus baris dobel (tanggal+siswa, dst). Yang disimpan: baris paling bawah (terbaru). */
function bersihkanDobel_(name) {
  const sh = sheet_(name), uk = UNIQUE[name], h = SCHEMA[name];
  const last = sh.getLastRow(); if (last < 3) return 0;
  const vals = sh.getRange(2, 1, last - 1, h.length).getDisplayValues().filter(r => r[0] !== '');
  const ci = uk.map(k => h.indexOf(k));
  const keep = {}; vals.forEach((r, i) => keep[ci.map(c => r[c]).join('|')] = i);
  const out = vals.filter((r, i) => keep[ci.map(c => r[c]).join('|')] === i);
  if (out.length === last - 1) return 0;
  sh.getRange(2, 1, last - 1, h.length).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, h.length).setNumberFormat('@').setValues(out);
  return (last - 1) - out.length;
}
function bersihkanDataDobel() { Object.keys(UNIQUE).forEach(n => Logger.log(n + ': ' + bersihkanDobel_(n) + ' baris dobel dihapus')); }

/* ---------------- INPUT LANGSUNG DI GOOGLE SHEET ----------------
 * Siswa & Guru boleh diketik langsung di sheet. Kolom kosong (id, pin/kode, status, dst)
 * terisi otomatis saat portal admin dibuka / ada login, atau jalankan fungsi ini manual.
 */
function fillSheet_(name, fillers, idPrefix, digits) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const h = SCHEMA[name];
  const rng = sh.getRange(2, 1, last - 1, h.length);
  const vals = rng.getDisplayValues();
  const c = k => h.indexOf(k);
  let max = 0;
  vals.forEach(r => { const m = String(r[0]).match(new RegExp('^' + idPrefix + '(\\d+)$')); if (m && +m[1] > max) max = +m[1]; });
  let changed = 0;
  vals.forEach(r => {
    if (!String(r[c('nama')]).trim()) return;
    const before = r.join('|');
    if (!r[0]) r[0] = idPrefix + String(++max).padStart(digits, '0');
    Object.keys(fillers).forEach(k => { if (!r[c(k)]) r[c(k)] = fillers[k](); });
    if (r.join('|') !== before) changed++;
  });
  if (changed) rng.setNumberFormat('@').setValues(vals);
  return changed;
}
const rand4_ = () => String(Math.floor(1000 + Math.random() * 9000));
function lengkapiDataSiswa() {
  return fillSheet_('Siswa', { pin: rand4_, kodeOrtu: rand4_, level: () => '1', status: () => 'Aktif', tglMulai: today_, jk: () => 'P' }, 'JMK', 3);
}
function lengkapiDataGuru() {
  return fillSheet_('Guru', { pin: rand4_, status: () => 'Aktif', tipeTarif: () => 'Per kehadiran', tarif: () => '0' }, 'G', 2);
}

/* ---------------- SETUP (jalankan sekali) ---------------- */

function setup() {
  Object.keys(SCHEMA).forEach(sheet_);
  const def = ss_().getSheetByName('Sheet1') || ss_().getSheetByName('Lembar1');
  if (def && def.getLastRow() === 0 && ss_().getSheets().length > 1) ss_().deleteSheet(def);
  if (!readTable_('Users').length) {
    upsertMany_('Users', [{ username: 'admin', passwordHash: hash_('jarimath123'), nama: 'Admin JariMath', role: 'admin' }]);
  }
  saveSettings_({}); // menulis pengaturan default yang belum ada
  lengkapiDataSiswa();
  lengkapiDataGuru();
  Logger.log('Setup selesai. Login admin: admin / jarimath123 (segera ganti).');
}

function resetAdminPassword() {
  const u = readTable_('Users').find(r => r.username === 'admin');
  if (u) { u.passwordHash = hash_('jarimath123'); upsertMany_('Users', [u]); }
  Logger.log('Password admin direset ke: jarimath123');
}
