/* Transcríbelo — transcribe eventos largos en el navegador (móvil, tablet u ordenador).
   - Texto en directo: reconocimiento de voz del navegador (Chrome/Edge; usa los servidores de Google, gratis).
   - Audio de respaldo: MediaRecorder, guardado a trozos cada 10 s (si se cierra la app no se pierde).
   - Todo se guarda en IndexedDB del dispositivo. Salen fuera: la voz (al reconocimiento de Google, si hay texto en directo)
     y lo que tú decidas copiar a Claude o compartir. */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------- Base de datos local ---------- */
let db;
function abrirBD() {
  return new Promise((ok, mal) => {
    const r = indexedDB.open('transcribelo', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sesiones', { keyPath: 'id' });
      d.createObjectStore('segmentos', { keyPath: 'k', autoIncrement: true }).createIndex('s', 'sid');
      d.createObjectStore('audio', { keyPath: 'k', autoIncrement: true }).createIndex('s', 'sid');
    };
    r.onsuccess = () => { db = r.result; ok(); };
    r.onerror = () => mal(r.error);
  });
}
function tx(store, modo, fn) {
  return new Promise((ok, mal) => {
    const t = db.transaction(store, modo); const st = t.objectStore(store);
    let res; const q = fn(st); if (q) q.onsuccess = () => { res = q.result; };
    t.oncomplete = () => ok(res); t.onerror = () => mal(t.error); t.onabort = () => mal(t.error);
  });
}
const guardarSesion = (s) => tx('sesiones', 'readwrite', (st) => st.put(s));
const leerSesion = (id) => tx('sesiones', 'readonly', (st) => st.get(id));
const todasSesiones = () => tx('sesiones', 'readonly', (st) => st.getAll());
const anadirSegmento = (g) => tx('segmentos', 'readwrite', (st) => st.add(g));
const segmentosDe = (sid) => tx('segmentos', 'readonly', (st) => st.index('s').getAll(sid));
const audiosDe = (sid) => tx('audio', 'readonly', (st) => st.index('s').getAll(sid));
async function borrarDe(store, sid) {
  const filas = await tx(store, 'readonly', (st) => st.index('s').getAllKeys(sid));
  await tx(store, 'readwrite', (st) => { filas.forEach((k) => st.delete(k)); });
}

/* ---------- Utilidades ---------- */
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000));
  return [s / 3600, (s % 3600) / 60, s % 60].map((n) => String(Math.floor(n)).padStart(2, '0')).join(':'); };
const aMs = (t) => { const p = t.split(':').map(Number); while (p.length < 3) p.unshift(0); return ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fechaBonita = (iso) => { try { return new Date(iso + 'T12:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return iso; } };
const nombreArchivo = (s) => (s.fecha + '_' + s.titulo).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '_').replace(/_+/g, '_').slice(0, 70);
let toastT;
function aviso(msg, ms = 2800) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

/* ---------- Navegación ---------- */
let sesion = null; // sesión abierta
function ver(id, titulo) {
  $$('.vista').forEach((v) => (v.hidden = v.id !== id));
  $('#btnInicio').hidden = id === 'vInicio' || id === 'vGrabar';
  $('#tituloBarra').textContent = titulo || 'Transcríbelo';
  window.scrollTo(0, 0);
}
$('#btnInicio').onclick = () => irInicio();

async function irInicio() {
  ver('vInicio');
  const ss = (await todasSesiones()).sort((a, b) => b.creada - a.creada);
  const ul = $('#listaSesiones'); ul.innerHTML = '';
  $('#sinSesiones').hidden = ss.length > 0;
  for (const s of ss) {
    const li = document.createElement('li');
    const estado = s.estado === 'grabando' ? ' · <span style="color:var(--peligro)">se cortó: ábrelo para seguir</span>' : '';
    li.innerHTML = `<b>${esc(s.titulo)}</b><span class="tenue">${fechaBonita(s.fecha)} · ${hms(s.duracion || 0)}${s.textoIA ? ' · ✓ ordenado' : ''}${estado}</span>`;
    li.onclick = () => abrirSesion(s.id);
    ul.appendChild(li);
  }
}

/* ---------- Compatibilidad ---------- */
const Reconocedor = window.SpeechRecognition || window.webkitSpeechRecognition;
function comprobarNavegador() {
  const msgs = [];
  if (!Reconocedor) msgs.push('Este navegador no tiene transcripción en directo. Usa <b>Chrome</b> (Android u ordenador) o Edge. Aquí solo podrás grabar audio.');
  if (!window.isSecureContext) msgs.push('La app no está abierta desde una dirección segura (https): el micrófono no funcionará.');
  if (!window.MediaRecorder) msgs.push('Este navegador no puede grabar audio.');
  if (msgs.length) { $('#avisoNav').innerHTML = msgs.join('<br>'); $('#avisoNav').hidden = false; }
}

/* ---------- Nuevo evento ---------- */
$('#btnNuevo').onclick = () => {
  $('#fTitulo').value = ''; $('#fFecha').value = new Date().toISOString().slice(0, 10);
  if (!Reconocedor) $('input[name=modo][value=audio]').checked = true;
  ver('vNuevo', 'Nuevo evento');
};
$('#btnEmpezar').onclick = async () => {
  const modo = $('input[name=modo]:checked').value;
  if (modo !== 'audio' && !Reconocedor) return aviso('Este navegador no transcribe en directo: elige «Solo audio» o usa Chrome.', 4500);
  const s = {
    id: 's' + Date.now(), creada: Date.now(),
    titulo: $('#fTitulo').value.trim() || 'Evento sin nombre',
    fecha: $('#fFecha').value || new Date().toISOString().slice(0, 10),
    ponentes: $('#fPonentes').value.trim(), lugar: $('#fLugar').value.trim(),
    idioma: $('#fIdioma').value, modo, duracion: 0, estado: 'grabando', textoIA: '', partes: 0,
  };
  await guardarSesion(s);
  sesion = s;
  empezarGrabacion();
};

/* ---------- Grabación ---------- */
const G = { activa: false, pausada: false, acumulado: 0, desde: 0, rec: null, mr: null, stream: null,
  ultimoFinal: '', reloj: null, parte: 0, seq: 0, nSeg: 0, nPal: 0, fallosAudio: 0, ultimoResultado: 0,
  wake: null, ctx: null, oculto: 0 };
const transcurrido = () => G.acumulado + (G.activa && !G.pausada ? Date.now() - G.desde : 0);

function pintarSeg(g) {
  const caja = $('#textoVivo'); const p = document.createElement('div');
  if (g.tipo === 'tema') { p.className = 'tema'; p.textContent = '§ ' + g.texto; }
  else if (g.tipo === 'marca') { p.className = 'marca'; p.textContent = '★ ' + (g.texto || 'Momento importante'); }
  else if (g.tipo === 'hueco') { p.className = 'hueco'; p.textContent = '⚠ ' + g.texto; }
  else { p.innerHTML = `<span class="t">${hms(g.t)}</span>${esc(g.texto)}`; }
  const prov = $('#provisional');
  caja.insertBefore(p, prov || null);
  if (caja.scrollHeight - caja.scrollTop - caja.clientHeight < 160) caja.scrollTop = caja.scrollHeight;
}
async function nuevoSeg(tipo, texto, t = transcurrido()) {
  const g = { sid: sesion.id, t, tipo, texto };
  pintarSeg(g);
  try { await anadirSegmento(g); } catch { avisoGrabar('⚠ No se pudo guardar el texto en el dispositivo (¿memoria llena?).'); }
  if (tipo === 'texto') { G.nSeg++; G.nPal += texto.split(/\s+/).length; }
  $('#contador').textContent = `${G.nPal.toLocaleString('es-ES')} palabras captadas · guardado automático en el dispositivo`;
}
function estado(txt, clase) { $('#estadoTxt').textContent = txt; $('#luz').className = 'luz ' + (clase || ''); }
function avisoGrabar(html) {
  const a = $('#avisoGrabar');
  if (!html) { a.innerHTML = ''; a.hidden = true; return; }
  if (!a.innerHTML.includes(html)) a.innerHTML += (a.innerHTML ? '<br><br>' : '') + html;
  a.hidden = false;
}

async function pedirPantallaEncendida() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') G.wake = await navigator.wakeLock.request('screen'); } catch { /* no disponible */ }
}

async function empezarGrabacion(continuar = false) {
  ver('vGrabar', sesion.titulo);
  $('#textoVivo').innerHTML = '<div id="provisional" class="provisional"></div>';
  Object.assign(G, { activa: true, pausada: false, acumulado: sesion.duracion || 0, desde: Date.now(), ultimoFinal: '',
    nSeg: 0, nPal: 0, fallosAudio: 0, ultimoResultado: Date.now(), parte: (sesion.partes || 0) + 1, seq: 0 });
  sesion.partes = G.parte; sesion.estado = 'grabando'; await guardarSesion(sesion);
  if (continuar) {
    const prev = await segmentosDe(sesion.id); prev.slice(-30).forEach(pintarSeg);
    await nuevoSeg('hueco', 'La grabación se reanudó aquí.');
  }
  avisoGrabar('');
  await pedirPantallaEncendida();
  const modo = sesion.modo;
  if (modo === 'ambos' || modo === 'audio') await empezarAudio();
  if (modo === 'ambos' || modo === 'texto') empezarTexto();
  estado(modo === 'audio' ? 'Grabando audio' : 'Escuchando', 'on');
  clearInterval(G.reloj);
  G.reloj = setInterval(tic, 1000);
  history.pushState({ grabando: 1 }, '');
}

function tic() {
  $('#reloj').textContent = hms(transcurrido());
  if (!G.activa || G.pausada) return;
  if (!G.rec && !G.mr) { estado('⚠ NO está grabando: revisa el permiso del micrófono', ''); return; }
  sesion.duracion = transcurrido();
  if (Math.floor(sesion.duracion / 1000) % 15 === 0) guardarSesion(sesion);
  // Vigilancia del audio: que el grabador siga vivo, lleguen trozos y haya sonido
  if (G.mr) {
    const pista = G.stream && G.stream.getAudioTracks()[0];
    if (G.mr.state === 'inactive' || (pista && pista.readyState === 'ended')) {
      avisoGrabar('<b style="color:var(--peligro)">⚠ El audio de respaldo se ha cortado.</b> Pulsa Terminar y luego «Seguir grabando».');
    } else if (Date.now() - G.ultimoTrozo > 30000) {
      avisoGrabar('<b style="color:var(--peligro)">⚠ El audio de respaldo no se está guardando.</b>');
    }
    if (Date.now() - G.ultimoSonido > 90000) estado('⚠ El micrófono no oye nada desde hace 1,5 min', 'on');
  }
  // Vigilancia: si hace mucho que no llega texto, avisar (micrófono lejos, sin internet…)
  if (G.rec && Date.now() - G.ultimoResultado > 60000) {
    estado('Sin texto desde hace 1 min…', 'on');
    if (Date.now() - G.ultimoResultado > 62000 && Date.now() - G.ultimoResultado < 64000) reiniciarTexto();
  }
}

/* --- Texto en directo --- */
function empezarTexto() {
  const r = new Reconocedor();
  r.lang = sesion.idioma; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
  r.onstart = () => { G.ultimoFinal = ''; G.huboTexto = false; };
  G.espera = 250; G.vacios = 0;
  r.onresult = (e) => {
    G.ultimoResultado = Date.now(); G.espera = 250; G.huboTexto = true; G.vacios = 0;
    let provisional = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i]; let t = res[0].transcript.trim();
      if (!res.isFinal) { provisional += ' ' + t; continue; }
      // Arreglo para Android: a veces repite lo anterior y añade lo nuevo al final
      const prev = G.ultimoFinal;
      if (prev && t.toLowerCase() === prev.toLowerCase()) continue;
      if (prev && prev.length > 8 && t.toLowerCase().startsWith(prev.toLowerCase())) t = t.slice(prev.length).trim();
      G.ultimoFinal = res[0].transcript.trim();
      if (t) nuevoSeg('texto', t);
    }
    const p = $('#provisional'); if (p) p.textContent = provisional.trim();
    if (!G.pausada) estado(sesion.modo === 'ambos' ? 'Escuchando + grabando audio' : 'Escuchando', 'on');
  };
  r.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'network') { G.espera = Math.min(10000, (G.espera || 250) * 2); estado('Sin internet: reintentando… (el audio sigue grabándose si lo elegiste)', 'on'); }
    else if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      avisoGrabar('El navegador no deja usar el micrófono para transcribir. Revisa los permisos del micrófono de Chrome para esta página.');
      G.rec = null; return;
    } else if (e.error === 'audio-capture') {
      G.fallosAudio++;
      if (G.fallosAudio >= 3 && G.mr) {
        avisoGrabar('<b>Este móvil no deja grabar audio y transcribir a la vez.</b> Sigo grabando solo el <b>audio</b> (el texto lo sacarás luego en el ordenador). Si prefieres texto en directo, pulsa Terminar y crea el evento con «Solo texto en directo».');
        G.rec = null; return;
      }
    } else estado('Aviso: ' + e.error + ' (reintentando)', 'on');
  };
  r.onend = () => {
    // En muchos Android, si se graba audio a la vez, el reconocedor no oye nada,
    // se apaga y vuelve a encenderse con un pitido cada pocos segundos: lo paramos.
    if (G.rec === r && !G.huboTexto && G.mr) {
      G.vacios = (G.vacios || 0) + 1;
      if (G.vacios >= 3) {
        G.rec = null;
        avisoGrabar('<b>En este móvil el texto en directo no funciona a la vez que el audio.</b> He parado el texto (se acaban los pitidos). <b>El audio sigue grabándose</b>: el texto lo sacarás luego en el ordenador.');
        estado('Grabando audio', 'on');
        return;
      }
    }
    // El navegador corta cada cierto tiempo: se vuelve a encender solo
    if (G.rec === r && G.activa && !G.pausada) setTimeout(() => { if (G.rec === r && G.activa && !G.pausada) { try { r.start(); } catch { /* ya activo */ } } }, G.espera || 250);
  };
  G.rec = r;
  try { r.start(); } catch { /* */ }
}
function reiniciarTexto() { if (!G.rec) return; const r = G.rec; try { r.abort(); } catch { /* */ } }
function pararTexto() { const r = G.rec; G.rec = null; if (r) { try { r.stop(); } catch { /* */ } } }

/* --- Audio de respaldo --- */
async function empezarAudio() {
  try {
    G.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    avisoGrabar('No se pudo usar el micrófono para el audio: ' + esc(String(err.message || err)) + '. Revisa el permiso del micrófono.');
    return;
  }
  const tipos = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];
  const mime = tipos.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  const mr = new MediaRecorder(G.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : {});
  const parte = G.parte;
  mr.ondataavailable = (e) => {
    if (e.data && e.data.size) G.ultimoTrozo = Date.now();
    if (e.data && e.data.size) tx('audio', 'readwrite', (st) => st.add({ sid: sesion.id, parte, seq: G.seq++, mime: mr.mimeType || mime || 'audio/webm', blob: e.data }))
      .catch(() => avisoGrabar('⚠ No queda espacio para guardar el audio en el dispositivo.'));
  };
  mr.onerror = () => avisoGrabar('<b style="color:var(--peligro)">⚠ Error en la grabación del audio.</b>');
  G.ultimoTrozo = Date.now(); G.ultimoSonido = Date.now();
  mr.start(10000);
  G.mr = mr;
  // Medidor de volumen (para ver que el micrófono oye)
  try {
    G.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = G.ctx.createAnalyser(); an.fftSize = 512; G.ctx.createMediaStreamSource(G.stream).connect(an);
    const buf = new Uint8Array(an.fftSize); $('#nivel').hidden = false;
    const medir = () => { if (!G.ctx) return; an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128));
      if (m > 3) G.ultimoSonido = Date.now();
      $('#nivelBarra').style.width = Math.min(100, m / 1.0) + '%'; requestAnimationFrame(medir); };
    medir();
  } catch { /* sin medidor */ }
}
function pararAudio() {
  return new Promise((ok) => {
    const mr = G.mr; G.mr = null;
    const fin = () => { if (G.stream) G.stream.getTracks().forEach((t) => t.stop()); G.stream = null;
      if (G.ctx) { G.ctx.close().catch(() => {}); G.ctx = null; } $('#nivel').hidden = true; ok(); };
    if (mr && mr.state !== 'inactive') { mr.onstop = () => setTimeout(fin, 300); mr.stop(); } else fin();
  });
}

/* --- Botones durante la grabación --- */
$('#btnPausa').onclick = () => {
  if (!G.pausada) {
    G.acumulado = transcurrido(); G.pausada = true;
    if (G.rec) { try { G.rec.stop(); } catch { /* */ } }
    if (G.mr && G.mr.state === 'recording') G.mr.pause();
    estado('En pausa', 'pausa'); $('#btnPausa').textContent = '▶ Seguir';
    sesion.duracion = G.acumulado; guardarSesion(sesion);
  } else {
    G.pausada = false; G.desde = Date.now(); G.ultimoResultado = Date.now();
    if (G.rec) { try { G.rec.start(); } catch { /* */ } }
    if (G.mr && G.mr.state === 'paused') G.mr.resume();
    G.ultimoTrozo = Date.now(); G.ultimoSonido = Date.now();
    estado('Escuchando', 'on'); $('#btnPausa').textContent = '❚❚ Pausa';
  }
};
$('#btnMarca').onclick = () => { nuevoSeg('marca', 'Momento importante'); aviso('★ Marcado en ' + hms(transcurrido())); };
$('#btnTema').onclick = () => {
  const t = prompt('Título del nuevo tema (ej.: «Preguntas del público»):');
  if (t && t.trim()) nuevoSeg('tema', t.trim());
};
$('#btnTerminar').onclick = async () => {
  if (!confirm('¿Terminar la grabación?')) return;
  G.acumulado = transcurrido(); G.activa = false; clearInterval(G.reloj);
  pararTexto(); await pararAudio();
  try { if (G.wake) await G.wake.release(); } catch { /* */ } G.wake = null;
  sesion.duracion = G.acumulado; sesion.estado = 'terminada'; await guardarSesion(sesion);
  aviso('Guardado ✓');
  abrirSesion(sesion.id);
};
document.addEventListener('visibilitychange', async () => {
  if (!G.activa) return;
  if (document.visibilityState === 'hidden') { G.oculto = transcurrido(); }
  else {
    await pedirPantallaEncendida();
    if (G.rec && !G.pausada) { try { G.rec.start(); } catch { /* ya activo */ } }
    if (G.oculto && sesion.modo !== 'audio' && transcurrido() - G.oculto > 5000)
      nuevoSeg('hueco', `Posible hueco de ${hms(transcurrido() - G.oculto)}: la app estuvo en segundo plano o con la pantalla apagada.`, G.oculto);
    G.oculto = 0;
  }
});
window.addEventListener('popstate', () => {
  if (G.activa) { history.pushState({ grabando: 1 }, ''); aviso('Se está grabando. Para salir, pulsa ■ Terminar.', 4000); }
});
window.addEventListener('beforeunload', (e) => { if (G.activa) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- Ver un evento ---------- */
async function abrirSesion(id) {
  sesion = await leerSesion(id); if (!sesion) return irInicio();
  ver('vSesion', sesion.titulo);
  const extra = [fechaBonita(sesion.fecha), sesion.lugar, sesion.ponentes, 'Duración ' + hms(sesion.duracion || 0)].filter(Boolean).join(' · ');
  $('#infoSesion').textContent = extra;
  const av = $('#avisoSesion');
  if (sesion.estado === 'grabando') { av.innerHTML = 'Esta grabación se cortó (se cerró la app o el móvil). Lo captado está guardado. Pulsa <b>Seguir grabando</b> si el evento continúa.'; av.hidden = false; sesion.estado = 'terminada'; guardarSesion(sesion); }
  else av.hidden = true;
  const segs = await segmentosDe(id);
  $('#txtBruto').value = segsATexto(segs);
  $('#txtIA').value = sesion.textoIA || '';
  $('#vistaIA').innerHTML = mdAHtml(sesion.textoIA || '');
  $('#selVersion').value = sesion.textoIA ? 'ia' : 'limpia';
  pintarLimpia();
  pintarAudios();
  pestana('pTrans');
}
function segsATexto(segs) {
  return segs.sort((a, b) => a.t - b.t || a.k - b.k).map((g) => {
    const p = g.tipo === 'tema' ? '## ' : g.tipo === 'marca' ? '★ ' : g.tipo === 'hueco' ? '⚠ ' : '';
    return `[${hms(g.t)}] ${p}${g.texto}`;
  }).join('\n');
}
function textoASegs(txt, sid) {
  let ultimo = 0;
  return txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = l.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)(?:[.,]\d+)?\]\s*(.*)$/);
    let t = ultimo, resto = l;
    if (m) { t = aMs(m[1]); resto = m[2]; ultimo = t; }
    let tipo = 'texto';
    if (resto.startsWith('## ')) { tipo = 'tema'; resto = resto.slice(3); }
    else if (resto.startsWith('★')) { tipo = 'marca'; resto = resto.replace(/^★\s*/, ''); }
    else if (resto.startsWith('⚠')) { tipo = 'hueco'; resto = resto.replace(/^⚠\s*/, ''); }
    return { sid, t, tipo, texto: resto.trim() };
  }).filter((g) => g.texto || g.tipo === 'marca');
}
async function reemplazarSegs(segs) {
  const viejos = await tx('segmentos', 'readonly', (st) => st.index('s').getAllKeys(sesion.id));
  await tx('segmentos', 'readwrite', (st) => { viejos.forEach((k) => st.delete(k)); segs.forEach((g) => st.add(g)); });
}
$('#btnGuardarBruto').onclick = async () => {
  await reemplazarSegs(textoASegs($('#txtBruto').value, sesion.id));
  pintarLimpia(); aviso('Cambios guardados ✓');
};
$('#btnContinuar').onclick = async () => {
  if (sesion.modo !== 'audio' && !Reconocedor) sesion.modo = 'audio';
  await empezarGrabacion(true);
};

function pestana(id) {
  $$('.pestanas button').forEach((b) => b.classList.toggle('activa', b.dataset.p === id));
  $$('.panel').forEach((p) => (p.hidden = p.id !== id));
  if (id === 'pIA') $('#verPrompt').textContent = instrucciones();
}
$$('.pestanas button').forEach((b) => (b.onclick = () => pestana(b.dataset.p)));

async function pintarAudios() {
  const filas = await audiosDe(sesion.id);
  const caja = $('#cajaAudio'), l = $('#listaAudios'); l.innerHTML = '';
  caja.hidden = !filas.length; if (!filas.length) return;
  const partes = {}; filas.forEach((f) => (partes[f.parte] = partes[f.parte] || []).push(f));
  for (const [n, fs] of Object.entries(partes)) {
    fs.sort((a, b) => a.seq - b.seq);
    const mime = fs[0].mime.split(';')[0]; const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm';
    const blob = new Blob(fs.map((f) => f.blob), { type: mime });
    const nom = `${nombreArchivo(sesion)}_audio${Object.keys(partes).length > 1 ? '_parte' + n : ''}.${ext}`;
    const d = document.createElement('div'); d.className = 'botonera';
    const b1 = document.createElement('button'); b1.className = 'medio'; b1.textContent = `Enviar audio${Object.keys(partes).length > 1 ? ' (parte ' + n + ')' : ''} · ${blob.size < 1048576 ? Math.ceil(blob.size / 1024) + ' KB' : (blob.size / 1048576).toFixed(1) + ' MB'}`;
    b1.onclick = () => entregar(new File([blob], nom, { type: mime }));
    const au = document.createElement('audio'); au.controls = true; au.src = URL.createObjectURL(blob); au.style.width = '100%';
    l.appendChild(au); d.appendChild(b1); l.appendChild(d);
  }
  const p = document.createElement('p'); p.className = 'tenue';
  p.textContent = 'Para sacar un texto de más calidad: pasa este audio al ordenador y arrástralo sobre «Transcribir audio.bat». Luego importa el .txt aquí (pantalla de inicio).';
  l.appendChild(p);
}

/* ---------- Limpieza automática (sin IA, sin internet) ---------- */
const MULETILLAS = /(^|[\s,])(e+h+|e+h?m+|e{2,}|h?m{2,}|a+h+)(?=[\s,.?!]|$)/gi;
function limpiarFrase(t) {
  let s = ' ' + t + ' ';
  s = s.replace(MULETILLAS, '$1');
  s = s.replace(/(?<!\p{L})(\p{L}+)(?:\s+\1)+(?!\p{L})/giu, '$1');          // «que que» → «que»
  s = s.replace(/\s+([,.;:?!])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/^[,;.\s]+/, '');
  if (!s) return '';
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.?!…:]$/.test(s)) s += '.';
  return s;
}
function textoLimpio() {
  const segs = textoASegs($('#txtBruto').value, sesion.id);
  const out = [`# ${sesion.titulo}`, '', cabecera(), ''];
  let parrafo = [], largo = 0, ultimoT = -1, inicioP = 0;
  const cerrar = () => { if (parrafo.length) { out.push(`*[${hms(inicioP)}]* ${parrafo.join(' ')}`, ''); } parrafo = []; largo = 0; };
  for (const g of segs) {
    if (g.tipo === 'tema') { cerrar(); out.push('## ' + g.texto, ''); continue; }
    if (g.tipo === 'marca') { cerrar(); out.push(`> ★ Momento destacado (${hms(g.t)})`, ''); continue; }
    if (g.tipo === 'hueco') continue;
    const f = limpiarFrase(g.texto); if (!f) continue;
    if (parrafo.length && (largo > 650 || (ultimoT >= 0 && g.t - ultimoT > 8000))) cerrar();
    if (!parrafo.length) inicioP = g.t;
    parrafo.push(f); largo += f.length; ultimoT = g.t;
  }
  cerrar();
  return out.join('\n').trim();
}
function cabecera() {
  return [fechaBonita(sesion.fecha), sesion.lugar, sesion.ponentes ? 'Ponentes: ' + sesion.ponentes : ''].filter(Boolean).join(' · ');
}
function pintarLimpia() { $('#vistaLimpia').innerHTML = mdAHtml(textoLimpio()); }

/* ---------- Versión ordenada con IA (Claude, con tu cuenta) ---------- */
function instrucciones() {
  const idioma = { 'es-ES': 'castellano', 'ca-ES': 'catalán', 'en-US': 'inglés' }[sesion?.idioma] || 'castellano';
  return `Eres un editor. Abajo tienes la transcripción automática de un evento («${sesion?.titulo || ''}», ${sesion ? fechaBonita(sesion.fecha) : ''}${sesion?.ponentes ? ', ponentes: ' + sesion.ponentes : ''}). La transcripción tiene errores, muletillas, repeticiones y frases cortadas.

Prepara un DOCUMENTO PARA LOS ASISTENTES, en ${idioma}, que les permita leer lo que se explicó. Reglas:
1. No resumas en exceso: conserva todas las ideas, explicaciones, ejemplos, pasos, herramientas, cifras y enlaces que se mencionaron.
2. Quita lo que sobra: muletillas, repeticiones, frases a medias, avisos logísticos (micrófono, descansos, «¿se me oye?»), bromas sin contenido y conversaciones fuera del tema.
3. Ordena por temas, con títulos claros (## Título). Usa párrafos cortos y listas cuando haya pasos o enumeraciones.
4. NO inventes nada. Si una palabra o nombre parece mal transcrito y no estás seguro, escríbelo y añade [?]. Si falta información, no la completes.
5. No pongas nombres ni datos personales de las personas del público; en las preguntas, escribe «Una persona del público preguntó…».
6. Estructura:
   # (título del evento)
   Un párrafo inicial de 3-4 líneas: de qué trató.
   ## (un apartado por cada tema, en el orden en que se trataron)
   ## Preguntas del público (si las hubo: pregunta y respuesta resumidas)
   ## Ideas clave (5-10 puntos)
   ## Herramientas y recursos mencionados (si los hubo)
7. Las líneas marcadas con ★ son momentos que el ponente marcó como importantes: dales relevancia. Las líneas «## …» son cambios de tema marcados durante el evento.
8. Responde SOLO con el documento, en formato Markdown, sin comentarios antes ni después.

TRANSCRIPCIÓN:
`;
}
$('#btnCopiarIA').onclick = async () => {
  const txt = instrucciones() + $('#txtBruto').value;
  try { await navigator.clipboard.writeText(txt); aviso('Copiado ✓ Ahora ábrelo en Claude y pega.', 3500); }
  catch { const ta = $('#verPrompt'); ta.textContent = txt; ta.parentElement.open = true; aviso('No se pudo copiar solo: selecciona el texto y cópialo a mano.', 4500); }
};
$('#btnGuardarIA').onclick = async () => {
  sesion.textoIA = $('#txtIA').value.trim(); await guardarSesion(sesion);
  $('#vistaIA').innerHTML = mdAHtml(sesion.textoIA);
  if (sesion.textoIA) $('#selVersion').value = 'ia';
  aviso('Guardado ✓');
};

/* ---------- Markdown sencillo ---------- */
function enLinea(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<i>$2</i>'); }
function mdAHtml(md) {
  if (!md) return '';
  const out = []; let lista = null;
  const cerrarLista = () => { if (lista) { out.push(`</${lista}>`); lista = null; } };
  for (const raw of md.split(/\r?\n/)) {
    const l = raw.trimEnd(); let m;
    if (!l.trim()) { cerrarLista(); continue; }
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { cerrarLista(); const n = m[1].length; out.push(`<h${n}>${enLinea(m[2])}</h${n}>`); }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (lista !== 'ul') { cerrarLista(); out.push('<ul>'); lista = 'ul'; } out.push(`<li>${enLinea(m[1])}</li>`); }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (lista !== 'ol') { cerrarLista(); out.push('<ol>'); lista = 'ol'; } out.push(`<li>${enLinea(m[1])}</li>`); }
    else if ((m = l.match(/^>\s?(.*)/))) { cerrarLista(); out.push(`<blockquote>${enLinea(m[1])}</blockquote>`); }
    else { cerrarLista(); out.push(`<p>${enLinea(l)}</p>`); }
  }
  cerrarLista();
  return out.join('\n');
}
const sinMd = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1$2');

/* ---------- Exportar ---------- */
const MARCA_IA = 'Documento elaborado con ayuda de inteligencia artificial a partir de la transcripción automática del evento. Puede contener errores.';
function textoVersion(v) {
  if (v === 'ia') return sesion.textoIA;
  if (v === 'limpia') return textoLimpio();
  return `# ${sesion.titulo} — transcripción completa\n\n${cabecera()}\n\n` + $('#txtBruto').value;
}
$$('#pExport [data-f]').forEach((b) => (b.onclick = () => exportar(b.dataset.f)));
async function exportar(f) {
  const v = $('#selVersion').value;
  if (!$('#txtBruto').value.trim() && !sesion.textoIA) return aviso('Este evento aún no tiene texto (solo audio). Pestaña 1 → «Enviar audio» al ordenador → arrástralo a «Transcribir audio.bat» → y en la app: Inicio → «Importar una transcripción».', 9000);
  let md = textoVersion(v);
  if (!md || !md.trim()) return aviso(v === 'ia' ? 'Aún no hay versión ordenada: hazla en la pestaña 3, o elige otra versión.' : 'No hay texto todavía.', 4500);
  if (v !== 'ia' && !confirm('Ojo: esta versión no quita los nombres que se dijeran del público. Para los asistentes es mejor la «Ordenada por IA». ¿Continuar?')) return;
  const sufijo = { ia: '', limpia: '_limpia', bruta: '_transcripcion' }[v];
  const base = nombreArchivo(sesion) + sufijo;
  let file;
  if (f === 'md') file = new File([md + '\n\n---\n*' + MARCA_IA + '*\n'], base + '.md', { type: 'text/markdown' });
  else if (f === 'txt') file = new File([sinMd(md).replace(/^#{1,4}\s+/gm, '').replace(/^>\s?/gm, '') + '\n\n— ' + MARCA_IA + '\n'], base + '.txt', { type: 'text/plain' });
  else if (f === 'doc') file = new File([htmlWord(md)], base + '.doc', { type: 'application/msword' });
  else {
    if (!window.jspdf) return aviso('Falta la pieza del PDF (se descarga la primera vez con internet). Conéctate y recarga la app.', 5000);
    file = new File([crearPDF(md, v === 'bruta')], base + '.pdf', { type: 'application/pdf' });
  }
  entregar(file);
}
async function entregar(file) {
  if ($('#chkCompartir').checked && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  aviso('Descargado: ' + file.name, 4000);
}
function htmlWord(md) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(sesion.titulo)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}h1{font-size:20pt;color:#7a2e1f}h2{font-size:14pt;color:#7a2e1f;margin-top:16pt}blockquote{color:#a8452f}.ia{color:#777;font-size:9pt;margin-top:24pt}</style></head><body>
${mdAHtml(md)}<p class="ia">${MARCA_IA}</p></body></html>`;
}
function crearPDF(md, compacto) {
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const M = 20, W = 210 - 2 * M, ALTO = 297, ABAJO = ALTO - 20;
  let y = M;
  // jsPDF con letra estándar: acentos y ñ sí; emojis y símbolos raros no
  const limpia = (s) => sinMd(s).replace(/[★]/g, '*').replace(/[⚠]/g, '!').replace(/[“”«»]/g, '"').replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/€/g, 'EUR').replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '');
  const escribir = (txt, tam, estilo, color, antes, interlinea, sangria = 0) => {
    pdf.setFont('helvetica', estilo); pdf.setFontSize(tam); pdf.setTextColor(...color);
    const lineas = pdf.splitTextToSize(limpia(txt), W - sangria);
    const alto = tam * 0.3528 * interlinea;
    y += antes;
    if (y + alto > ABAJO) { pdf.addPage(); y = M; }
    for (const l of lineas) { if (y + alto > ABAJO) { pdf.addPage(); y = M; } pdf.text(l, M + sangria, y + alto * 0.8); y += alto; }
  };
  const cuerpo = compacto ? 9.5 : 11;
  let n = 0;
  for (const raw of md.split(/\r?\n/)) {
    const l = raw.trim(); let m;
    if (!l) { y += compacto ? 0.5 : 1.5; continue; }
    if ((m = l.match(/^#\s+(.*)/))) { escribir(m[1], 19, 'bold', [122, 46, 31], n ? 6 : 0, 1.25); y += 1; }
    else if ((m = l.match(/^##\s+(.*)/))) { escribir(m[1], 14, 'bold', [122, 46, 31], 5, 1.3); }
    else if ((m = l.match(/^#{3,4}\s+(.*)/))) { escribir(m[1], 12, 'bold', [40, 33, 28], 3, 1.3); }
    else if ((m = l.match(/^[-*•]\s+(.*)/))) { escribir('-  ' + m[1], cuerpo, 'normal', [30, 30, 30], 0.6, 1.4, 4); }
    else if ((m = l.match(/^(\d+[.)])\s+(.*)/))) { escribir(m[1] + ' ' + m[2], cuerpo, 'normal', [30, 30, 30], 0.6, 1.4, 4); }
    else if ((m = l.match(/^>\s?(.*)/))) { escribir(m[1], cuerpo, 'italic', [168, 69, 47], 1, 1.4, 4); }
    else escribir(l, cuerpo, 'normal', [30, 30, 30], compacto ? 0.3 : 1, 1.45);
    n++;
  }
  const total = pdf.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    pdf.setPage(i); pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(120, 120, 120);
    pdf.text(limpia(sesion.titulo).slice(0, 80), M, ALTO - 10);
    pdf.text(`${i} / ${total}`, 210 - M, ALTO - 10, { align: 'right' });
    if (i === total) { const ls = pdf.splitTextToSize(MARCA_IA, W); pdf.text(ls, M, ALTO - 16 - (ls.length - 1) * 3.5); }
  }
  return pdf.output('blob');
}

/* ---------- Importar y borrar ---------- */
$('#archivoImportar').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const txt = await f.text();
  const s = { id: 's' + Date.now(), creada: Date.now(), titulo: f.name.replace(/\.(txt|md)$/i, '').replace(/_/g, ' '),
    fecha: new Date().toISOString().slice(0, 10), ponentes: '', lugar: '', idioma: 'es-ES', modo: 'audio', duracion: 0, estado: 'terminada', textoIA: '', partes: 0 };
  const segs = textoASegs(txt.replace(/^#.*$/gm, ''), s.id);
  s.duracion = segs.length ? segs[segs.length - 1].t : 0;
  await guardarSesion(s); sesion = s; await reemplazarSegs(segs);
  e.target.value = ''; aviso('Importado ✓'); abrirSesion(s.id);
};
$('#btnBorrar').onclick = async () => {
  if (!confirm(`¿Borrar «${sesion.titulo}» de este dispositivo? Se borran el texto y el audio, y no se puede deshacer.`)) return;
  await borrarDe('segmentos', sesion.id); await borrarDe('audio', sesion.id);
  await tx('sesiones', 'readwrite', (st) => st.delete(sesion.id));
  aviso('Borrado'); irInicio();
};

/* ---------- Arranque ---------- */
(async () => {
  await abrirBD();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  comprobarNavegador();
  irInicio();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js?v=3').catch(() => {});
})();
