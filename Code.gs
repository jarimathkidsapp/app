/**
 * ============================================================
 *  JARIMATH KIDS — Portal Admin, Murid & Orang Tua
 *  Backend: Google Apps Script + Google Spreadsheet
 * ============================================================
 *  Cara pakai singkat (detail di PANDUAN.md):
 *  1. Buat Google Spreadsheet baru → Extensions → Apps Script.
 *  2. Tempel file ini ke Code.gs, buat file HTML bernama "Index"
 *     lalu tempel isi Index.html.
 *  3. Jalankan fungsi setup() sekali (izinkan akses).
 *  4. Deploy → New deployment → Web app
 *       Execute as: Me | Who has access: Anyone
 *  5. Buka URL /exec → login admin: admin / jarimath123 (segera ganti).
 * ============================================================
 */

// Kosongkan jika script dibuat dari dalam spreadsheet (Extensions → Apps Script).
// Isi dengan ID spreadsheet jika script dibuat terpisah.
const SS_ID = '';
const SESSION_SECONDS = 21600; // 6 jam (maksimum CacheService)

const SCHEMA = {
  Pengaturan:  ['key', 'value'],
  Users:       ['id', 'username', 'passwordHash', 'nama', 'role'],
  Siswa:       ['id', 'nama', 'panggilan', 'jk', 'tglLahir', 'ortu', 'waOrtu', 'alamat', 'tglMulai', 'level', 'status', 'sppNominal', 'pin', 'kodeOrtu', 'catatan'],
  Guru:        ['id', 'nama', 'wa', 'status', 'catatan'],
  Jadwal:      ['id', 'hari', 'sesi', 'jamMulai', 'jamSelesai', 'tipe', 'guruId', 'siswaIds', 'catatan'],
  Absensi:     ['id', 'tanggal', 'siswaId', 'status', 'guruId', 'catatan'],
  AbsensiGuru: ['id', 'tanggal', 'guruId', 'status', 'jamMasuk', 'jamKeluar', 'jamMengajar', 'catatan'],
  SPP:         ['id', 'noInvoice', 'siswaId', 'periode', 'nominal', 'tanggalBayar', 'metode', 'catatan'],
  Laporan:     ['id', 'siswaId', 'periode', 'level', 'hadir', 'pertemuan', 'rataNilai', 'bintang', 'pencapaian', 'catatanGuru', 'dibuat'],
  Nilai:       ['id', 'siswaId', 'tanggal', 'level', 'benar', 'total', 'skor', 'durasi', 'bintang'],
  Bintang:     ['id', 'siswaId', 'tanggal', 'jumlah', 'tipe', 'keterangan'],
  Soal:        ['id', 'level', 'soal', 'jawaban', 'aktif']
};
const ADMIN_TABLES = ['Siswa', 'Guru', 'Jadwal', 'Absensi', 'AbsensiGuru', 'SPP', 'Laporan', 'Nilai', 'Bintang', 'Soal'];

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
  portalUrl: ''
};

/* ---------------- ENTRY POINTS ---------------- */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('JariMath Kids — Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Dipakai bila Index.html di-host terpisah (Netlify, dll) → fetch POST ke URL /exec
function doPost(e) {
  let res;
  try { res = route_(JSON.parse(e.postData.contents)); }
  catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

// Dipakai bila Index.html dibuka langsung dari URL Apps Script (google.script.run)
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
  if (s.role === 'murid' || s.role === 'ortu') {
    if (a === 'me') return { ok: true, data: me_(s) };
    if (a === 'submitQuiz' && s.role === 'murid') return { ok: true, result: withLock_(() => submitQuiz_(s, req)) };
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
  } else if (role === 'murid' || role === 'ortu') {
    const s = readTable_('Siswa').find(r => r.id.toUpperCase() === user.toUpperCase());
    const key = role === 'murid' ? 'pin' : 'kodeOrtu';
    if (s && String(s[key]) === pass && s.status !== 'Berhenti') profile = { id: s.id, nama: s.nama, panggilan: s.panggilan };
  }
  if (!profile) return { ok: false, error: role === 'admin' ? 'Username atau password salah.' : 'ID siswa atau kode salah.' };

  const token = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('s_' + token, JSON.stringify({ role: role, uid: profile.id }), SESSION_SECONDS);
  return { ok: true, token: token, role: role, profile: profile };
}

function getSession_(token) {
  if (!token) return null;
  const v = CacheService.getScriptCache().get('s_' + token);
  if (!v) return null;
  CacheService.getScriptCache().put('s_' + token, v, SESSION_SECONDS); // perpanjang
  return JSON.parse(v);
}

function changePassword_(s, req) {
  const users = readTable_('Users');
  const u = users.find(r => r.id === s.uid);
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

/* ---------------- DATA: ADMIN ---------------- */

function bootstrap_() {
  const db = {};
  ADMIN_TABLES.forEach(t => db[t] = readTable_(t));
  return { db: db, settings: getSettings_() };
}

/* ---------------- DATA: MURID & ORTU ---------------- */

function me_(s) {
  const siswa = readTable_('Siswa').find(r => r.id === s.uid);
  if (!siswa) throw new Error('Data siswa tidak ditemukan');
  const mine = t => readTable_(t).filter(r => r.siswaId === s.uid);
  const guru = readTable_('Guru');
  const jadwal = readTable_('Jadwal')
    .filter(j => String(j.siswaIds).split(',').map(x => x.trim()).indexOf(s.uid) > -1)
    .map(j => { const g = guru.find(x => x.id === j.guruId); return Object.assign({}, j, { guruNama: g ? g.nama : '' }); });
  const safe = Object.assign({}, siswa); delete safe.pin; delete safe.kodeOrtu;
  return {
    role: s.role,
    siswa: safe,
    settings: publicSettings_(),
    Absensi: mine('Absensi'),
    SPP: s.role === 'ortu' ? mine('SPP') : [],
    Laporan: s.role === 'ortu' ? mine('Laporan') : [],
    Nilai: mine('Nilai'),
    Bintang: mine('Bintang'),
    Jadwal: jadwal,
    Soal: s.role === 'murid' ? readTable_('Soal').filter(q => q.aktif !== 'Tidak') : []
  };
}

function submitQuiz_(s, req) {
  const siswa = readTable_('Siswa').find(r => r.id === s.uid);
  const level = Math.max(1, Math.min(4, Number(req.level) || 1));
  if (level > (Number(siswa.level) || 1)) throw new Error('Level ini belum terbuka.');
  const total = Math.max(1, Math.min(50, Number(req.total) || 10));
  const benar = Math.max(0, Math.min(total, Number(req.benar) || 0));
  const skor = Math.round(benar / total * 100);
  const bintang = skor >= 90 ? 3 : skor >= 75 ? 2 : skor >= 60 ? 1 : 0;
  const tgl = Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd');
  upsertMany_('Nilai', [{ siswaId: s.uid, tanggal: tgl, level: level, benar: benar, total: total, skor: skor, durasi: Number(req.durasi) || 0, bintang: bintang }]);
  if (bintang > 0) upsertMany_('Bintang', [{ siswaId: s.uid, tanggal: tgl, jumlah: bintang, tipe: 'Latihan', keterangan: 'Latihan Level ' + level + ' (skor ' + skor + ')' }]);
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
  return { namaLembaga: s.namaLembaga, tagline: s.tagline, alamat: s.alamat, noWa: s.noWa, rekening: s.rekening, jatuhTempo: s.jatuhTempo, nominalSPP: s.nominalSPP, tahunAjaran: s.tahunAjaran, portalUrl: s.portalUrl };
}
function saveSettings_(obj) {
  const sh = sheet_('Pengaturan');
  const cur = getSettings_();
  Object.keys(obj).forEach(k => cur[k] = obj[k]);
  const rows = Object.keys(cur).map(k => [k, String(cur[k])]);
  sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 2).clearContent();
  sh.getRange(2, 1, rows.length, 2).setNumberFormat('@').setValues(rows);
}

/* ---------------- SHEET HELPERS ---------------- */

function ss_() { return SS_ID ? SpreadsheetApp.openById(SS_ID) : SpreadsheetApp.getActiveSpreadsheet(); }

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    const h = SCHEMA[name];
    sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold').setBackground('#E31183').setFontColor('#FFFFFF');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), h.length).setNumberFormat('@'); // semua teks: nomor WA & PIN tidak hilang nol depannya
  }
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
  if (name === 'Siswa') {
    let max = 0;
    existing.forEach(r => { const n = parseInt(String(r.id).replace(/\D/g, ''), 10); if (n > max) max = n; });
    return 'JMK' + ('00' + (max + 1)).slice(-3);
  }
  return name.slice(0, 2).toUpperCase() + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function upsertMany_(name, rows) {
  const sh = sheet_(name);
  const h = SCHEMA[name];
  const existing = readTable_(name);
  const idx = {}; existing.forEach((r, i) => idx[r.id] = i + 2);
  const out = [], appends = [];
  rows.forEach(row => {
    const r = Object.assign({}, row);
    if (!r.id || !idx[r.id]) {
      if (!r.id) r.id = newId_(name, existing.concat(out));
      if (name === 'SPP' && !r.noInvoice) r.noInvoice = 'INV-' + String(r.periode).replace('-', '') + '-' + r.siswaId;
      appends.push(h.map(k => r[k] == null ? '' : String(r[k])));
    } else {
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

/* ---------------- SETUP (jalankan sekali) ---------------- */

function setup() {
  Object.keys(SCHEMA).forEach(sheet_);
  const def = ss_().getSheetByName('Sheet1') || ss_().getSheetByName('Lembar1');
  if (def && def.getLastRow() === 0 && ss_().getSheets().length > 1) ss_().deleteSheet(def);

  if (!readTable_('Users').length) {
    upsertMany_('Users', [{ username: 'admin', passwordHash: hash_('jarimath123'), nama: 'Admin JariMath', role: 'admin' }]);
  }
  if (!readTable_('Pengaturan').length) saveSettings_(DEFAULT_SETTINGS);

  if (!readTable_('Siswa').length) {
    upsertMany_('Guru', [{ id: 'G01', nama: 'Bu Risya', wa: '081234567890', status: 'Aktif', catatan: '' }]);
    upsertMany_('Siswa', [{
      nama: 'Contoh Siswa', panggilan: 'Contoh', jk: 'P', tglLahir: '2018-05-12', ortu: 'Ibu Contoh',
      waOrtu: '081234567890', alamat: '-', tglMulai: Utilities.formatDate(new Date(), 'Asia/Jakarta', 'yyyy-MM-dd'),
      level: '1', status: 'Aktif', sppNominal: '', pin: '1234', kodeOrtu: '5678', catatan: 'Data contoh — boleh dihapus'
    }]);
  }
  Logger.log('Setup selesai. Login admin: admin / jarimath123. Contoh murid: JMK001 PIN 1234, kode ortu 5678');
}

// Reset password admin bila lupa (jalankan dari editor)
function resetAdminPassword() {
  const u = readTable_('Users').find(r => r.username === 'admin');
  if (u) { u.passwordHash = hash_('jarimath123'); upsertMany_('Users', [u]); }
  Logger.log('Password admin direset ke: jarimath123');
}
