/* OCR PDF — reconnaissance de caractères français/anglais, traduction, lecture vocale, exports.
   Application web empaquetée en APK avec Capacitor (voir build-apk.yml). */
(function () {
'use strict';

const $ = id => document.getElementById(id);
const Cap = window.Capacitor || null;
const natif = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const Plug = (Cap && Cap.Plugins) || {};
const synth = window.speechSynthesis || null;

/* ------------------------------------------------------------------ */
/* Stockage local et réglages                                          */
/* ------------------------------------------------------------------ */
function lire(c) { try { return JSON.parse(localStorage.getItem(c)); } catch (e) { return null; } }
function ecrire(c, v) { try { localStorage.setItem(c, JSON.stringify(v)); return true; } catch (e) { return false; } }

const DEF = {
  langOcr: 'fra+eng', mode: 'auto', resolution: '3', prepro: 'aucun',
  sens: 'en-fr', moteur: 'mymemory',
  gemKey: '', gemModele: 'gemini-2.5-flash', mmEmail: '',
  marquerPages: true, garderImages: true
};
const reg = Object.assign({}, DEF, lire('ocrpdf.reg') || {});

document.querySelectorAll('[data-reg]').forEach(el => {
  const k = el.dataset.reg;
  if (el.type === 'checkbox') el.checked = !!reg[k]; else el.value = reg[k];
  el.addEventListener('change', () => {
    reg[k] = el.type === 'checkbox' ? el.checked : el.value;
    ecrire('ocrpdf.reg', reg);
    if (k === 'sens') majLangueTrad();
  });
});

/* ------------------------------------------------------------------ */
/* Interface : onglets, messages, progression                          */
/* ------------------------------------------------------------------ */
function onglet(n) {
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + n));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === n));
  window.scrollTo(0, 0);
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => onglet(b.dataset.tab)));

let tmrToast;
function message(t) {
  const e = $('toast');
  e.textContent = t;
  e.classList.add('visible');
  clearTimeout(tmrToast);
  tmrToast = setTimeout(() => e.classList.remove('visible'), 4200);
}
function statut(t) { $('statut').textContent = t; }
function progression(p, txt) {
  $('barre').hidden = false;
  $('barre').value = Math.round(p);
  if (txt !== undefined) $('detailProgres').textContent = txt;
}

let wakeLock = null;
async function verrouEcran() { try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* ignoré */ } }
function libererEcran() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignoré */ } wakeLock = null; }

/* ------------------------------------------------------------------ */
/* Sélection des fichiers                                              */
/* ------------------------------------------------------------------ */
let selection = [];
const estPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

$('fichier').addEventListener('change', e => {
  selection = Array.from(e.target.files || []);
  e.target.value = '';
  if (!selection.length) { $('infoFichier').textContent = 'Aucun fichier sélectionné.'; return; }
  const nbPdf = selection.filter(estPdf).length;
  const noms = selection.length > 3 ? selection.slice(0, 3).map(f => f.name).join(', ') + '…' : selection.map(f => f.name).join(', ');
  $('infoFichier').textContent = `${noms} — ${nbPdf} PDF, ${selection.length - nbPdf} image(s)`;
  $('nomExport').value = selection[0].name.replace(/\.[^.]+$/, '');
});

function analyserPlage(s, n) {
  const tout = Array.from({ length: n }, (_, i) => i + 1);
  s = (s || '').trim();
  if (!s) return tout;
  const set = new Set();
  s.split(/[,;\s]+/).forEach(tok => {
    const m = tok.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return;
    let a = +m[1], b = m[2] ? +m[2] : a;
    if (a > b) { const x = a; a = b; b = x; }
    for (let i = Math.max(1, a); i <= Math.min(n, b); i++) set.add(i);
  });
  const r = Array.from(set).sort((x, y) => x - y);
  return r.length ? r : tout;
}

/* ------------------------------------------------------------------ */
/* Reconnaissance                                                      */
/* ------------------------------------------------------------------ */
let pages = [];        // résultats par page
let annule = false;
let worker = null;
let progressCb = null;
let courantId = null;

function urlBase() { return new URL('.', location.href).href; }

async function creerWorker(langs) {
  const base = urlBase();
  return await Tesseract.createWorker(langs, 1, {
    workerPath: base + 'tesseract/worker.min.js',
    corePath: base + 'tesseract/',
    langPath: base + 'tessdata',
    gzip: false,
    workerBlobURL: false,
    logger: m => { if (m && m.status === 'recognizing text' && progressCb) progressCb(m.progress || 0); }
  });
}

function assemblerTexte(tc) {
  let out = '';
  for (const it of tc.items) {
    if (!('str' in it)) continue;
    out += it.str;
    if (it.hasEOL) out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function otsu(g) {
  const h = new Array(256).fill(0);
  for (let i = 0; i < g.length; i++) h[g[i]]++;
  const total = g.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * h[t];
  let sB = 0, wB = 0, max = 0, seuil = 127;
  for (let t = 0; t < 256; t++) {
    wB += h[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sB += t * h[t];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > max) { max = v; seuil = t; }
  }
  return seuil;
}

function pretraiter(canvas, mode) {
  if (mode === 'aucun') return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const n = d.length / 4;
  const g = new Uint8ClampedArray(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
    g[j] = v; hist[v]++;
  }
  let cum = 0, lo = 0, hi = 255;
  const s1 = n * 0.01, s2 = n * 0.99;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= s1) { lo = v; break; } }
  cum = 0;
  for (let v = 0; v < 256; v++) { cum += hist[v]; if (cum >= s2) { hi = v; break; } }
  if (hi <= lo) hi = lo + 1;
  const sc = 255 / (hi - lo);
  for (let j = 0; j < n; j++) g[j] = (g[j] - lo) * sc;   // Uint8ClampedArray borne les valeurs
  const seuil = mode === 'nb' ? otsu(g) : -1;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    let v = g[j];
    if (seuil >= 0) v = v > seuil ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

function versJpeg(canvas, max, q) {
  const s = Math.min(1, max / Math.max(canvas.width, canvas.height));
  if (s === 1) return canvas.toDataURL('image/jpeg', q);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}

function extraireMots(data) {
  let mots = data.words;
  if (!mots && data.blocks) {
    mots = [];
    data.blocks.forEach(b => (b.paragraphs || []).forEach(p => (p.lines || []).forEach(l => (l.words || []).forEach(w => mots.push(w)))));
  }
  return (mots || []).filter(w => w.text && w.text.trim() && w.bbox).map(w => ({
    t: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1, c: Math.round(w.confidence || 0)
  }));
}

async function chargerImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Image illisible : ' + file.name));
      i.src = url;
    });
    const s = Math.min(1, 3200 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

async function reconnaitre(canvas, meta, getWorker, onProg) {
  const image = reg.garderImages ? versJpeg(canvas, 1800, 0.62) : null;
  pretraiter(canvas, reg.prepro);
  const w = await getWorker();
  progressCb = onProg;
  const { data } = await w.recognize(canvas);
  progressCb = null;
  return {
    source: 'ocr', nom: meta.nom, num: meta.num, texte: (data.text || '').trim(),
    mots: extraireMots(data), conf: Math.round(data.confidence || 0),
    image, w: canvas.width, h: canvas.height
  };
}

async function traiterTache(t, getWorker, onProg) {
  if (t.type === 'img') {
    const canvas = await chargerImage(t.file);
    return reconnaitre(canvas, { nom: t.nom, num: t.num }, getWorker, onProg);
  }
  const page = await t.pdf.getPage(t.num);
  if (reg.mode === 'auto') {
    const tc = await page.getTextContent();
    const txt = assemblerTexte(tc);
    if ((txt.match(/[\p{L}\p{N}]/gu) || []).length >= 40) {
      page.cleanup();
      return { source: 'texte', nom: t.nom, num: t.num, texte: txt, mots: [], conf: null, image: null, w: 0, h: 0 };
    }
  }
  const vp = page.getViewport({ scale: parseFloat(reg.resolution) || 3 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return reconnaitre(canvas, { nom: t.nom, num: t.num }, getWorker, onProg);
}

function construireTexte() {
  const multi = selection.length > 1;
  return pages.map(p => {
    const marque = reg.marquerPages ? `--- ${multi ? p.nom + ' — ' : ''}Page ${p.num} ---\n` : '';
    return marque + p.texte;
  }).join('\n\n');
}

function basculerBoutons(enCours) {
  $('btnLancer').hidden = enCours;
  $('btnAnnuler').hidden = !enCours;
}

async function lancer() {
  if (!window.Tesseract || !window.pdfjsLib) { message('Bibliothèques manquantes : reconstruisez l\'APK.'); return; }
  if (!selection.length) { message('Choisissez d\'abord un fichier.'); return; }
  annule = false;
  pages = [];
  courantId = null;
  basculerBoutons(true);
  statut('Reconnaissance…');
  await verrouEcran();
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = urlBase() + 'lib/pdf.worker.min.js';
    const taches = [];
    let numImg = 0;
    for (const f of selection) {
      if (estPdf(f)) {
        const buf = await f.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
        analyserPlage($('plage').value, pdf.numPages).forEach(n => taches.push({ type: 'pdf', pdf, num: n, nom: f.name }));
      } else {
        numImg++;
        taches.push({ type: 'img', file: f, num: numImg, nom: f.name });
      }
    }
    const getWorker = async () => { if (!worker) worker = await creerWorker(reg.langOcr); return worker; };
    for (let i = 0; i < taches.length; i++) {
      if (annule) break;
      const t = taches[i];
      const etiq = `Page ${i + 1}/${taches.length} — ${t.nom}`;
      progression(i / taches.length * 100, etiq);
      const res = await traiterTache(t, getWorker, p => progression((i + p) / taches.length * 100, etiq));
      pages.push(res);
      $('texte').value = construireTexte();
    }
    progression(100, annule ? `Arrêté après ${pages.length} page(s).` : `Terminé : ${pages.length} page(s).`);
    finaliser();
  } catch (err) {
    console.error(err);
    message('Erreur : ' + (err && err.message ? err.message : err));
    if (pages.length) finaliser();
  } finally {
    if (worker) { try { await worker.terminate(); } catch (e) { /* ignoré */ } worker = null; }
    progressCb = null;
    libererEcran();
    basculerBoutons(false);
    statut('Prêt');
  }
}

function detecterLangue(t) {
  const s = ' ' + t.toLowerCase().slice(0, 6000).replace(/[^\p{L}\s']/gu, ' ') + ' ';
  const fr = (s.match(/ (le|la|les|des|une|est|et|que|pour|dans|du|au|sur|avec) /g) || []).length;
  const en = (s.match(/ (the|and|of|to|is|that|for|with|in|are|this|from) /g) || []).length;
  return en > fr ? 'en' : 'fr';
}

function finaliser() {
  if (!pages.length) return;
  statistiques();
  const lg = detecterLangue($('texte').value);
  definirLangueTts('texte', lg);
  sauverHistorique();
  onglet('texte');
  message(lg === 'en' ? 'Texte en anglais détecté : prêt à traduire.' : 'Reconnaissance terminée.');
}

function statistiques() {
  const t = $('texte').value;
  const mots = (t.match(/[\p{L}\p{N}]+/gu) || []).length;
  const ocr = pages.filter(p => p.source === 'ocr');
  const nbTexte = pages.length - ocr.length;
  let s = `${pages.length} page(s) · ${mots} mots · ${t.length} caractères`;
  if (ocr.length) {
    const moy = Math.round(ocr.reduce((a, p) => a + p.conf, 0) / ocr.length);
    s += ` · confiance OCR moyenne ${moy} %`;
    const faibles = ocr.filter(p => p.conf < 70).map(p => p.num);
    if (faibles.length) s += ` · ⚠ à relire : page(s) ${faibles.join(', ')}`;
  }
  if (nbTexte) s += ` · ${nbTexte} page(s) à texte intégré`;
  $('stats').textContent = s;
}

$('btnLancer').addEventListener('click', lancer);
$('btnAnnuler').addEventListener('click', () => { annule = true; message('Arrêt après la page en cours…'); });

/* ------------------------------------------------------------------ */
/* Outils sur le texte                                                 */
/* ------------------------------------------------------------------ */
let texteAvant = null;
function memoriser() { texteAvant = $('texte').value; }

function nettoyer(t) {
  t = t.replace(/([\p{L}])-\n([\p{L}])/gu, '$1$2');          // coupures de mots
  return t.split(/\n{2,}/).map(p => {
    const l = p.split('\n');
    if (/^---.*---$/.test(l[0].trim()) && l[0].length < 120) {   // ligne « --- Page n --- » conservée
      return l[0].trim() + (l.length > 1 ? '\n' + l.slice(1).join(' ') : '');
    }
    return p.replace(/\s*\n\s*/g, ' ');
  }).join('\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function copier(txt) {
  try { await navigator.clipboard.writeText(txt); }
  catch (e) {
    const ta = document.createElement('textarea');
    ta.value = txt; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e2) { /* ignoré */ }
    ta.remove();
  }
  message('Copié.');
}

async function partagerTexte(txt) {
  if (!txt.trim()) { message('Rien à partager.'); return; }
  try {
    if (natif && Plug.Share) await Plug.Share.share({ text: txt, dialogTitle: 'Partager le texte' });
    else if (navigator.share) await navigator.share({ text: txt });
    else copier(txt);
  } catch (e) { /* partage annulé */ }
}

$('btnCopier').addEventListener('click', () => copier($('texte').value));
$('btnPartagerTexte').addEventListener('click', () => partagerTexte($('texte').value));
$('btnNettoyer').addEventListener('click', () => {
  memoriser();
  $('texte').value = nettoyer($('texte').value);
  statistiques();
  message('Texte nettoyé (lignes jointes, mots coupés réparés).');
});
$('btnAnnulerTexte').addEventListener('click', () => {
  if (texteAvant === null) { message('Rien à annuler.'); return; }
  $('texte').value = texteAvant; texteAvant = null; statistiques();
});
$('btnRemplacer').addEventListener('click', () => {
  const a = $('chercher').value;
  if (!a) return;
  memoriser();
  const ta = $('texte');
  const n = ta.value.split(a).length - 1;
  ta.value = ta.value.split(a).join($('remplacer').value);
  message(n + ' remplacement(s).');
});

/* ------------------------------------------------------------------ */
/* Lecture vocale                                                      */
/* ------------------------------------------------------------------ */
const tts = { jeton: 0, morceaux: [], i: 0, panel: null };

function decouperPhrases(t, max) {
  const sortie = [];
  t.split('\n').forEach(ligne => {
    ligne = ligne.trim();
    if (!ligne || /^---.*---$/.test(ligne)) return;
    const phrases = ligne.match(/[^.!?;:]+[.!?;:]*\s*/g) || [ligne];
    let cur = '';
    phrases.forEach(ph => {
      while (ph.length > max) {
        let cut = ph.lastIndexOf(' ', max);
        if (cut < 1) cut = max;
        if (cur) { sortie.push(cur.trim()); cur = ''; }
        sortie.push(ph.slice(0, cut).trim());
        ph = ph.slice(cut);
      }
      if ((cur + ph).length > max) { if (cur) sortie.push(cur.trim()); cur = ph; }
      else cur += ph;
    });
    if (cur.trim()) sortie.push(cur.trim());
  });
  return sortie.filter(Boolean);
}

function construireTts(panel) {
  panel.innerHTML = `
    <div class="rangee">
      <button data-a="lire" class="primaire">▶ Lire</button>
      <button data-a="pause">⏸ Pause</button>
      <button data-a="stop">⏹ Stop</button>
    </div>
    <label>Langue de lecture
      <select data-r="langue"><option value="fr">Français</option><option value="en">Anglais</option></select>
    </label>
    <label>Voix <select data-r="voix"></select></label>
    <label>Vitesse <input type="range" min="0.5" max="1.8" step="0.1" value="1" data-r="vitesse"></label>
    <label>Hauteur <input type="range" min="0.6" max="1.5" step="0.1" value="1" data-r="hauteur"></label>
    <div class="tts-etat"></div>
    <div class="info">« Lire » commence à la sélection ou au curseur dans le texte (sinon au début).</div>`;
  const get = r => panel.querySelector(`[data-r=${r}]`);
  get('langue').addEventListener('change', remplirVoix);
  panel.querySelector('[data-a=lire]').addEventListener('click', () => lireDepuis(panel));
  panel.querySelector('[data-a=pause]').addEventListener('click', () => pauseTts(panel));
  panel.querySelector('[data-a=stop]').addEventListener('click', () => stopTts(panel));
}

function etatTts(panel, t) { const e = panel.querySelector('.tts-etat'); if (e) e.textContent = t; }

function definirLangueTts(cible, lg) {
  const panel = document.querySelector(`.tts[data-cible="${cible}"]`);
  if (!panel) return;
  panel.querySelector('[data-r=langue]').value = lg;
  remplirVoix();
}

function majLangueTrad() { definirLangueTts('traduction', reg.sens === 'en-fr' ? 'fr' : 'en'); }

function remplirVoix() {
  if (!synth) return;
  const voix = synth.getVoices();
  document.querySelectorAll('.tts').forEach(p => {
    const sel = p.querySelector('[data-r=voix]');
    const lg = p.querySelector('[data-r=langue]').value;
    const cur = sel.value;
    sel.innerHTML = '';
    sel.add(new Option('Voix par défaut', ''));
    voix.filter(v => (v.lang || '').toLowerCase().startsWith(lg))
        .forEach(v => sel.add(new Option(`${v.name} (${v.lang})`, v.voiceURI)));
    sel.value = cur;
    if (sel.value !== cur) sel.value = '';
  });
}

function lireDepuis(panel) {
  if (!synth) { message('Synthèse vocale indisponible sur cet appareil.'); return; }
  const ta = $(panel.dataset.cible);
  let debut = ta.selectionStart || 0, fin = ta.selectionEnd || 0;
  if (debut >= ta.value.length) debut = 0;
  const texte = fin > debut ? ta.value.slice(debut, fin) : ta.value.slice(debut);
  const morceaux = decouperPhrases(texte, 220);
  if (!morceaux.length) { message('Aucun texte à lire.'); return; }
  lireMorceaux(panel, morceaux, 0);
}

function lireMorceaux(panel, morceaux, i0) {
  synth.cancel();
  const jeton = ++tts.jeton;
  tts.morceaux = morceaux; tts.i = i0; tts.panel = panel;
  const lg = panel.querySelector('[data-r=langue]').value;
  const code = lg === 'en' ? 'en-US' : 'fr-FR';
  const suivant = () => {
    if (jeton !== tts.jeton) return;
    if (tts.i >= morceaux.length) { etatTts(panel, 'Lecture terminée.'); return; }
    const u = new SpeechSynthesisUtterance(morceaux[tts.i]);
    u.lang = code;
    u.rate = parseFloat(panel.querySelector('[data-r=vitesse]').value) || 1;
    u.pitch = parseFloat(panel.querySelector('[data-r=hauteur]').value) || 1;
    const uri = panel.querySelector('[data-r=voix]').value;
    if (uri) { const v = synth.getVoices().find(x => x.voiceURI === uri); if (v) { u.voice = v; u.lang = v.lang; } }
    u.onend = () => { if (jeton !== tts.jeton) return; tts.i++; suivant(); };
    u.onerror = e => {
      if (jeton !== tts.jeton) return;
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      etatTts(panel, 'Erreur de voix : ' + e.error + ' (installez une voix dans les réglages Android).');
    };
    etatTts(panel, `Lecture… (${tts.i + 1}/${morceaux.length})`);
    synth.speak(u);
  };
  setTimeout(suivant, 80);
}

function pauseTts(panel) {
  if (!synth) return;
  const btn = panel.querySelector('[data-a=pause]');
  if (tts.panel === panel && tts.morceaux.length && btn.dataset.etat !== 'pause') {
    tts.jeton++; synth.cancel();
    btn.dataset.etat = 'pause'; btn.textContent = '▶ Reprendre';
    etatTts(panel, 'En pause.');
  } else if (btn.dataset.etat === 'pause') {
    btn.dataset.etat = ''; btn.textContent = '⏸ Pause';
    lireMorceaux(panel, tts.morceaux, tts.i);
  }
}

function stopTts(panel) {
  tts.jeton++;
  if (synth) synth.cancel();
  tts.morceaux = [];
  const btn = panel.querySelector('[data-a=pause]');
  btn.dataset.etat = ''; btn.textContent = '⏸ Pause';
  etatTts(panel, 'Arrêté.');
}

document.querySelectorAll('.tts').forEach(construireTts);
if (synth) {
  remplirVoix();
  synth.onvoiceschanged = remplirVoix;
  setTimeout(remplirVoix, 600);
  setTimeout(remplirVoix, 2000);
}
majLangueTrad();

/* ------------------------------------------------------------------ */
/* Traduction                                                          */
/* ------------------------------------------------------------------ */
let annulTrad = false;
const pause = ms => new Promise(r => setTimeout(r, ms));
const estSep = p => /^---.*---$/.test(p.trim()) && p.length < 120;
const versParas = t => t.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);

function decoderEntites(t) { const ta = document.createElement('textarea'); ta.innerHTML = t; return ta.value; }

async function traduireMM(s, de, vers) {
  let url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(s)}&langpair=${de}|${vers}`;
  if (reg.mmEmail) url += '&de=' + encodeURIComponent(reg.mmEmail);
  const r = await fetch(url);
  if (!r.ok) throw new Error('MyMemory : erreur HTTP ' + r.status);
  const j = await r.json();
  const t = j.responseData && j.responseData.translatedText;
  if (+j.responseStatus !== 200 || !t || /MYMEMORY WARNING/i.test(t)) {
    throw new Error('MyMemory : quota atteint ou erreur. Réessayez plus tard, ajoutez un e-mail dans Réglages, ou utilisez Gemini.');
  }
  return decoderEntites(t);
}

async function traduireGemini(texte, de, vers) {
  const langs = { fr: 'français', en: 'anglais' };
  const prompt = `Traduis fidèlement le texte suivant de l'${langs[de]} vers le ${langs[vers]}. ` +
    `Conserve les paragraphes (séparés par une ligne vide) et recopie telles quelles les lignes de la forme « --- Page n --- ». ` +
    `Réponds uniquement par la traduction, sans commentaire.\n\n${texte}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(reg.gemModele || 'gemini-2.5-flash')}:generateContent?key=${encodeURIComponent(reg.gemKey)}`;
  for (let essai = 0; essai < 3; essai++) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } })
    });
    if (r.status === 429 || r.status === 503) { await pause(3000 * (essai + 1)); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Gemini : ' + ((j.error && j.error.message) || 'erreur HTTP ' + r.status));
    const c = j.candidates && j.candidates[0];
    const t = c && c.content && c.content.parts ? c.content.parts.map(p => p.text || '').join('') : '';
    if (!t) throw new Error('Gemini : réponse vide (contenu bloqué ?).');
    return t.trim();
  }
  throw new Error('Gemini : service saturé, réessayez dans un instant.');
}

function lotsGemini(paras, max) {
  const lots = []; let cur = [], len = 0;
  paras.forEach(p => {
    const q = estSep(p) ? p : p.replace(/\s*\n\s*/g, ' ');
    if (len + q.length > max && cur.length) { lots.push(cur.join('\n\n')); cur = []; len = 0; }
    cur.push(q); len += q.length + 2;
  });
  if (cur.length) lots.push(cur.join('\n\n'));
  return lots;
}

async function traduire() {
  const src = $('texte').value.trim();
  if (!src) { message('Aucun texte à traduire : reconnaissez ou collez d\'abord un texte.'); return; }
  if (reg.moteur === 'gemini' && !reg.gemKey) { message('Saisissez la clé Gemini dans Réglages (ou choisissez MyMemory).'); onglet('reglages'); return; }
  const [de, vers] = reg.sens === 'en-fr' ? ['en', 'fr'] : ['fr', 'en'];
  const paras = versParas(src);
  annulTrad = false;
  $('btnTraduire').hidden = true; $('btnAnnulerTrad').hidden = false;
  $('barreTrad').hidden = false; $('barreTrad').value = 0;
  statut('Traduction…');
  await verrouEcran();
  const sortie = [];
  try {
    if (reg.moteur === 'gemini') {
      const lots = lotsGemini(paras, 5000);
      for (let i = 0; i < lots.length; i++) {
        if (annulTrad) break;
        $('detailTrad').textContent = `Lot ${i + 1}/${lots.length}`;
        $('barreTrad').value = i / lots.length * 100;
        sortie.push(await traduireGemini(lots[i], de, vers));
        $('traduction').value = sortie.join('\n\n');
      }
    } else {
      for (let i = 0; i < paras.length; i++) {
        if (annulTrad) break;
        $('detailTrad').textContent = `Paragraphe ${i + 1}/${paras.length}`;
        $('barreTrad').value = i / paras.length * 100;
        if (estSep(paras[i])) { sortie.push(paras[i]); continue; }
        const phrases = decouperPhrases(paras[i].replace(/\s*\n\s*/g, ' '), 450);
        const tr = [];
        for (const ph of phrases) {
          if (annulTrad) break;
          tr.push(await traduireMM(ph, de, vers));
          await pause(120);
        }
        sortie.push(tr.join(' '));
        $('traduction').value = sortie.join('\n\n');
      }
    }
    $('barreTrad').value = 100;
    $('detailTrad').textContent = annulTrad ? 'Traduction interrompue.' : 'Traduction terminée.';
    definirLangueTts('traduction', vers);
    if (sortie.length) sauverHistorique();
  } catch (err) {
    console.error(err);
    $('detailTrad').textContent = 'Erreur : ' + (err.message || err);
    message(err.message || 'Erreur de traduction.');
    if (sortie.length) sauverHistorique();
  } finally {
    libererEcran();
    $('btnTraduire').hidden = false; $('btnAnnulerTrad').hidden = true;
    statut('Prêt');
  }
}

$('btnTraduire').addEventListener('click', traduire);
$('btnAnnulerTrad').addEventListener('click', () => { annulTrad = true; });
$('btnCopierTrad').addEventListener('click', () => copier($('traduction').value));
$('btnPartagerTrad').addEventListener('click', () => partagerTexte($('traduction').value));

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */
function blobVersBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(new Error('Lecture du fichier impossible.'));
    r.readAsDataURL(blob);
  });
}

async function enregistrer(nom, blob) {
  if (natif && Plug.Filesystem && Plug.Share) {
    try {
      const b64 = await blobVersBase64(blob);
      const r = await Plug.Filesystem.writeFile({ path: nom, data: b64, directory: 'CACHE' });
      await Plug.Share.share({ title: nom, files: [r.uri], dialogTitle: 'Enregistrer ou partager ' + nom });
      return;
    } catch (e) {
      if (/cancel/i.test(String(e && (e.message || e)))) return;
      throw e;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

function elements() {
  const mode = $('contenuExport').value;
  const o = versParas($('texte').value), t = versParas($('traduction').value);
  const mk = (p, st) => ({ texte: p, style: estSep(p) ? 'sep' : st });
  if (mode === 'orig') return o.map(p => mk(p, 'orig'));
  if (mode === 'trad') return t.map(p => mk(p, 'orig'));
  if (o.length && o.length === t.length) {
    const r = [];
    o.forEach((p, i) => { r.push(mk(p, 'orig')); if (!estSep(p)) r.push(mk(t[i], 'trad')); });
    return r;
  }
  return [{ texte: 'Texte original', style: 'titre' }, ...o.map(p => mk(p, 'orig')),
          { texte: 'Traduction', style: 'titre' }, ...t.map(p => mk(p, 'orig'))];
}

const etiquette = t => t.replace(/^-+\s*/, '').replace(/\s*-+$/, '');

function construireTxt(els) {
  return els.map(x => x.style === 'trad' ? '→ ' + x.texte : x.style === 'titre' ? '=== ' + x.texte + ' ===' : x.texte).join('\n\n') + '\n';
}

function construireMd(els, titre) {
  const corps = els.map(x => {
    if (x.style === 'sep') return '---\n\n*' + etiquette(x.texte) + '*';
    if (x.style === 'titre') return '## ' + x.texte;
    const t = x.texte.replace(/\n/g, '  \n');
    return x.style === 'trad' ? '> ' + t.replace(/\n/g, '\n> ') : t;
  }).join('\n\n');
  return '# ' + titre + '\n\n' + corps + '\n';
}

function construireHtml(els, titre) {
  const e = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const corps = els.map(x => {
    const h = e(x.texte).replace(/\n/g, '<br>');
    if (x.style === 'sep') return `<hr><p class="sep">${e(etiquette(x.texte))}</p>`;
    if (x.style === 'titre') return `<h2>${h}</h2>`;
    return `<p class="${x.style}">${h}</p>`;
  }).join('\n');
  return `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${e(titre)}</title><style>body{font-family:Georgia,serif;max-width:46em;margin:2em auto;padding:0 1em;line-height:1.55;color:#222}` +
    `p.trad{color:#1f4e79;font-style:italic}p.sep{color:#777;text-align:center;font-size:.85em}</style></head>` +
    `<body><h1>${e(titre)}</h1>\n${corps}\n</body></html>\n`;
}

async function construireDocx(els, titre) {
  const xmlSafe = s => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
  const esc = s => xmlSafe(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const run = (txt, o) => {
    o = o || {};
    const rpr = `<w:rPr>${o.b ? '<w:b/>' : ''}${o.i ? '<w:i/>' : ''}${o.color ? `<w:color w:val="${o.color}"/>` : ''}${o.size ? `<w:sz w:val="${o.size}"/>` : ''}</w:rPr>`;
    return txt.split('\n').map((l, k) => `<w:r>${rpr}${k > 0 ? '<w:br/>' : ''}<w:t xml:space="preserve">${esc(l)}</w:t></w:r>`).join('');
  };
  const para = (inner, ppr) => `<w:p><w:pPr>${ppr || ''}<w:spacing w:after="160"/></w:pPr>${inner}</w:p>`;
  let corps = para(run(titre, { b: 1, size: 36 }));
  els.forEach(x => {
    if (x.style === 'sep') corps += para(run(etiquette(x.texte), { i: 1, color: '777777', size: 18 }), '<w:jc w:val="center"/>');
    else if (x.style === 'titre') corps += para(run(x.texte, { b: 1, size: 28 }));
    else if (x.style === 'trad') corps += para(run(x.texte, { i: 1, color: '1F4E79' }));
    else corps += para(run(x.texte));
  });
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${corps}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', doc);
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function san(s) {   // polices PDF standard : jeu Latin-1 uniquement
  return s.replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—‑]/g, '-').replace(/…/g, '...')
    .replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/€/g, 'EUR')
    .replace(/[\u00A0\u2009\u202F]/g, ' ').replace(/\t/g, ' ')
    .replace(/[^\n\x20-\x7E\u00A1-\u00FF]/g, '?');
}

function construirePdfTexte(els, titre) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const L = 18, W = 210 - 2 * L, B = 275;
  let y = 22;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
  doc.splitTextToSize(san(titre), W).forEach(l => { doc.text(l, L, y); y += 7; });
  y += 4;
  els.forEach(x => {
    doc.setFont('helvetica', x.style === 'trad' || x.style === 'sep' ? 'italic' : x.style === 'titre' ? 'bold' : 'normal');
    doc.setFontSize(x.style === 'sep' ? 9 : x.style === 'titre' ? 13 : 11);
    if (x.style === 'trad') doc.setTextColor(31, 78, 121); else if (x.style === 'sep') doc.setTextColor(120); else doc.setTextColor(0);
    const lignes = doc.splitTextToSize(san(x.style === 'sep' ? etiquette(x.texte) : x.texte), W);
    lignes.forEach(l => {
      if (y > B) { doc.addPage(); y = 20; }
      doc.text(l, x.style === 'sep' ? 105 : L, y, x.style === 'sep' ? { align: 'center' } : undefined);
      y += x.style === 'sep' ? 4.5 : 5.6;
    });
    y += x.style === 'titre' ? 2 : 3;
  });
  const n = doc.getNumberOfPages();
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(120);
  for (let i = 1; i <= n; i++) { doc.setPage(i); doc.text(`${i} / ${n}`, 105, 290, { align: 'center' }); }
  return doc.output('blob');
}

function construirePdfConsultable() {
  const avec = pages.filter(p => p.image);
  if (!avec.length) return null;
  const { jsPDF } = window.jspdf;
  let doc = null;
  avec.forEach(p => {
    const o = p.w > p.h ? 'l' : 'p';
    if (!doc) doc = new jsPDF({ unit: 'pt', format: [p.w, p.h], orientation: o, compress: true });
    else doc.addPage([p.w, p.h], o);
    doc.addImage(p.image, 'JPEG', 0, 0, p.w, p.h);
    doc.setFont('helvetica', 'normal');
    p.mots.forEach(m => {
      const t = san(m.t);
      if (!t.trim()) return;
      const h = Math.max(4, m.y1 - m.y0);
      doc.setFontSize(h * 0.8);
      const nat = doc.getTextWidth(t);
      const cs = t.length > 1 ? Math.max(-3, Math.min(30, ((m.x1 - m.x0) - nat) / t.length)) : 0;
      doc.text(t, m.x0, m.y1 - h * 0.2, { renderingMode: 'invisible', charSpace: cs });
    });
  });
  return doc.output('blob');
}

const nomSur = s => (s || '').replace(/[\\/:*?"<>|]+/g, '_').trim();

async function exporter(fmt) {
  try {
    const mode = $('contenuExport').value;
    const titre = nomSur($('nomExport').value) || 'document';
    const suffixe = mode === 'trad' ? '_traduction' : mode === 'bi' ? '_bilingue' : '';
    let blob, nom;
    if (fmt === 'pdfocr') {
      blob = construirePdfConsultable();
      if (!blob) { message('Aucune image en mémoire : activez « Conserver les images » (Réglages) et relancez la reconnaissance.'); return; }
      nom = titre + '_consultable.pdf';
    } else if (fmt === 'json') {
      const data = {
        fichier: titre, date: new Date().toISOString(),
        texte: $('texte').value, traduction: $('traduction').value,
        pages: pages.map(p => ({ numero: p.num, fichier: p.nom, source: p.source, confiance: p.conf, texte: p.texte,
          mots: p.mots.map(m => ({ texte: m.t, x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, confiance: m.c })) }))
      };
      blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
      nom = titre + '.json';
    } else {
      if ((mode === 'orig' || mode === 'bi') && !$('texte').value.trim()) { message('Le texte reconnu est vide.'); return; }
      if ((mode === 'trad' || mode === 'bi') && !$('traduction').value.trim()) { message('Aucune traduction disponible : traduisez d\'abord le texte.'); return; }
      const els = elements();
      switch (fmt) {
        case 'txt': blob = new Blob([construireTxt(els)], { type: 'text/plain;charset=utf-8' }); nom = titre + suffixe + '.txt'; break;
        case 'md': blob = new Blob([construireMd(els, titre)], { type: 'text/markdown;charset=utf-8' }); nom = titre + suffixe + '.md'; break;
        case 'html': blob = new Blob([construireHtml(els, titre)], { type: 'text/html;charset=utf-8' }); nom = titre + suffixe + '.html'; break;
        case 'docx': blob = await construireDocx(els, titre); nom = titre + suffixe + '.docx'; break;
        case 'pdf': blob = construirePdfTexte(els, titre); nom = titre + suffixe + '.pdf'; break;
        default: return;
      }
    }
    statut('Export…');
    await enregistrer(nom, blob);
  } catch (err) {
    console.error(err);
    message('Export impossible : ' + (err && err.message ? err.message : err));
  } finally { statut('Prêt'); }
}
document.querySelectorAll('[data-fmt]').forEach(b => b.addEventListener('click', () => exporter(b.dataset.fmt)));

/* ------------------------------------------------------------------ */
/* Historique                                                          */
/* ------------------------------------------------------------------ */
function sauverHistorique() {
  const liste = lire('ocrpdf.hist') || [];
  let e = liste.find(x => x.id === courantId);
  if (!e) { courantId = Date.now(); e = { id: courantId }; liste.unshift(e); }
  e.nom = $('nomExport').value || 'Sans titre';
  e.date = new Date().toISOString();
  e.texte = $('texte').value.slice(0, 250000);
  e.trad = $('traduction').value.slice(0, 250000);
  while (liste.length > 15) liste.pop();
  let ok = ecrire('ocrpdf.hist', liste);
  while (!ok && liste.length > 1) { liste.pop(); ok = ecrire('ocrpdf.hist', liste); }
  afficherHistorique();
}

function afficherHistorique() {
  const ul = $('historique');
  ul.innerHTML = '';
  const liste = lire('ocrpdf.hist') || [];
  if (!liste.length) { const li = document.createElement('li'); li.textContent = 'Aucun historique.'; ul.appendChild(li); return; }
  liste.forEach(e => {
    const li = document.createElement('li');
    const d = document.createElement('div');
    d.className = 'nom';
    d.textContent = e.nom;
    const sm = document.createElement('small');
    sm.textContent = new Date(e.date).toLocaleString('fr-FR') + ' · ' + (e.texte || '').length + ' car.';
    d.appendChild(sm);
    const ouvrir = document.createElement('button');
    ouvrir.textContent = 'Ouvrir';
    ouvrir.addEventListener('click', () => {
      courantId = e.id; pages = [];
      $('nomExport').value = e.nom; $('texte').value = e.texte || ''; $('traduction').value = e.trad || '';
      statistiques(); onglet('texte');
      message('Historique chargé (le PDF consultable demande de relancer la reconnaissance).');
    });
    const suppr = document.createElement('button');
    suppr.textContent = '✕'; suppr.className = 'danger';
    suppr.addEventListener('click', () => {
      ecrire('ocrpdf.hist', (lire('ocrpdf.hist') || []).filter(x => x.id !== e.id));
      afficherHistorique();
    });
    li.append(d, ouvrir, suppr);
    ul.appendChild(li);
  });
}
afficherHistorique();

/* petit accès pour les tests */
window.OcrPdf = { nettoyer, decouperPhrases, analyserPlage, detecterLangue, san, construireDocx, construireHtml, construireMd, construireTxt, lotsGemini };
})();
