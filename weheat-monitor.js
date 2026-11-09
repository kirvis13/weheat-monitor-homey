// Weheat Monitor voor Homey Pro (HomeyScript)
// https://github.com/kirvis13/weheat-monitor-homey
//
// Koppelt een thermostaat in Homey aan weheat-monitor.nl, zoals de
// Home Assistant-integratie (github.com/kirvis13/weheat-monitor-ha) dat doet:
// elke minuut de kamertemperatuur en het setpoint naar de site, en als je dat
// wilt het setpoint van het plan (of van de thermostaattest) naar de thermostaat.
//
// Je hoeft in dit script niets aan te passen. De instellingen staan in de flow:
// "Elke 1 minuut" → HomeyScript "Voer een script uit met argument", met als
// argument bijvoorbeeld
//
//   whm_...;Toon                     sleutel en de naam van je thermostaat
//   whm_...;Toon;volg                ook het plan en de thermostaattest volgen
//   whm_...;Toon;kamer=Woonkamer     een betere kamersensor
//   whm_...;Toon;tset=OTGW/target    gevraagde aanvoertemperatuur (apparaat/capability)
//   whm_...;Toon;ruimtes=alle        ook de temperatuursensoren in andere ruimtes
//   whm_...;Toon;ruimtes=Zolder,Hal  alleen die zones
//
// Een update is dus: het hele script vervangen door de nieuwe versie. Uitleg:
// README.md in de repository.
//
// Het script praat alleen met weheat-monitor.nl, nooit met Weheat zelf. De
// sleutel gaat alleen in de Authorization-kop mee en komt nooit in het log.

const VERSIE = "0.4.0";

// ─── Vaste waarden (gelijk aan de Home Assistant-integratie) ────────────────

const ADRES = "https://www.weheat-monitor.nl/api/v1/devices/sync";
const BRON = "homey";
const MAX_METINGEN = 100;             // contract: hooguit 100 metingen per aanroep
const MAX_TOEGEPAST = 20;             // en hooguit 20 plan_id's
const MAX_AANROEPEN = 3;              // per run; HomeyScript breekt een lang script af
const TIMEOUT_MS = 10_000;
const WACHTRIJ_MAX_MS = 24 * 3600_000 - 5 * 60_000;
const WACHTRIJ_MAX = 1500;
const MIN_SETPOINT = 12;
const MAX_SETPOINT = 24;
const TOLERANTIE = 0.05;
const PAUZE_MS = 4 * 3600_000;        // de mens wint: vier uur niet sturen
const THERMOSTAAT_MELDEN_MS = 24 * 3600_000;
const MAX_WACHT_MS = 15 * 60_000;     // na een fout: 1, 2, 4, 8, dan elk kwartier
const OPSLAG = "weheat_monitor_toestand";
const STORING_MELDEN_MS = 15 * 60_000; // pas na een kwartier storing een melding in de tijdlijn
const MAX_RUIMTE_METINGEN = 100;      // contract: hooguit 100 ruimtemetingen per aanroep
const RUIMTE_WACHTRIJ_MAX_MS = WACHTRIJ_MAX_MS;
const RUIMTE_WACHTRIJ_MAX = 3000;     // HomeyScript bewaart alles in één tekst: niet te groot
const RUIMTE_STIL_MS = 2 * 3600_000;  // twee uur geen nieuwe waarde: één melding in de tijdlijn

// ─── Ruimtes kiezen: gelijk in weheat-monitor.js en controle.js ────────────
// Niet op één plek bewerken: test/script.test.ts eist dat beide kopieën gelijk zijn.

const MAX_RUIMTES = 20;
const RUIMTE_SOORTEN = { humidity: "measure_humidity", co2: "measure_co2", pressure: "measure_pressure" };
const BUITEN_ZONE = /(^|[^a-z])(buiten|tuin|terras|balkon|outside|outdoor|garden)($|[^a-z])/i;
const BUITEN_NAAM = /(^|[^a-z])(buiten|outside|outdoor)/i;
const normaal = (t) => String(t ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const kort = (t, n) => String(t ?? "").trim().replace(/\s+/g, " ").slice(0, n).trim();

/** De zone van een apparaat en de zones erboven, van dichtbij naar ver. */
function zoneKeten(zoneId, zones) {
  const keten = [];
  let z = zoneId ? zones?.[zoneId] : null;
  while (z && keten.length < 10) { keten.push(z); z = z.parent ? zones[z.parent] : null; }
  return keten;
}

/** De zone; zonder zone de naam van het apparaat zonder "Temperatuur"; hooguit 40 tekens. */
function ruimteNaam(zone, apparaatNaam) {
  let n = kort(zone, 40);
  if (!n) n = kort(String(apparaatNaam ?? "").trim().replace(/[\s_-]*(temperatuur|temperature|temp|sensor)$/i, ""), 40);
  return n || "Ruimte";
}

const isBuiten = (zone, naam) => BUITEN_ZONE.test(String(zone ?? "")) || BUITEN_NAAM.test(String(naam ?? ""));

/**
 * Welke temperatuursensoren als ruimte meegaan. keuze: "alle" of een lijst met
 * zones (een zone telt ook voor de zones erin, dus een verdieping kan). Nooit
 * een thermostaat of radiatorkraan (die heeft een ingestelde temperatuur), nooit
 * buiten. Gesorteerd op zone en naam, hooguit 20.
 */
function kiesRuimtes(apparaten, zones, keuze) {
  const uit = { ruimtes: [], buiten: [], onbekend: [], teVeel: 0 };
  if (!keuze) return uit;
  const gevraagd = keuze === "alle" ? null : keuze.map(normaal);
  const kandidaten = [];
  for (const d of apparaten) {
    const c = d?.capabilitiesObj ?? {};
    if (!c.measure_temperature || c.target_temperature) continue;
    const keten = zoneKeten(d.zone, zones);
    const zone = keten[0]?.name ?? d.zoneName ?? "";
    if (gevraagd && !keten.some((z) => gevraagd.includes(normaal(z.name))) && !gevraagd.includes(normaal(zone))) continue;
    const r = {
      id: d.id, apparaat: d, apparaatNaam: d.name, zone: d.zone ?? null, zoneNaam: zone,
      naam: ruimteNaam(zone, d.name),
      // Homey kent geen verdiepingen; de zone erboven is het, tenzij dat het huis zelf is.
      verdieping: keten.length > 2 ? kort(keten[1].name, 20) || null : null,
    };
    (isBuiten(zone, d.name) ? uit.buiten : kandidaten).push(r);
  }
  kandidaten.sort((a, b) => normaal(a.naam).localeCompare(normaal(b.naam)) ||
    normaal(a.apparaatNaam).localeCompare(normaal(b.apparaatNaam)) || String(a.id).localeCompare(String(b.id)));
  uit.ruimtes = kandidaten.slice(0, MAX_RUIMTES);
  uit.teVeel = Math.max(0, kandidaten.length - MAX_RUIMTES);
  if (gevraagd) {
    const bekend = new Set([...Object.values(zones ?? {}).map((z) => normaal(z.name)), ...apparaten.map((d) => normaal(d?.zoneName))]);
    uit.onbekend = keuze.filter((k) => !bekend.has(normaal(k)));
  }
  return uit;
}

/**
 * Vocht, CO2 en luchtdruk bij een ruimte: eerst van hetzelfde apparaat, anders
 * de enige van die soort in dezelfde zone. Twee of meer in de zone: geen, want
 * een verkeerde sensor is erger dan geen waarde.
 */
function metgezellen(r, apparaten) {
  const uit = {};
  for (const [soort, cap] of Object.entries(RUIMTE_SOORTEN)) {
    if (r.apparaat.capabilitiesObj?.[cap]) { uit[soort] = r.apparaat; continue; }
    if (!r.zone) continue;
    const zelfde = apparaten.filter((d) => d !== r.apparaat && d?.zone === r.zone && d.capabilitiesObj?.[cap] && !isBuiten("", d.name));
    if (zelfde.length === 1) uit[soort] = zelfde[0];
  }
  return uit;
}
// ─── einde ruimtes kiezen ───

// ─── Regels (puur, getoetst door test/script.test.ts) ──────────────────────

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const tijd = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
const getal = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const klem = (x) => Math.max(MIN_SETPOINT, Math.min(MAX_SETPOINT, Number(x)));

/**
 * De instellingen uit het argument van de flowkaart: sleutel;thermostaat, dan
 * losse opties (volg, kamer=naam, tset=apparaat/capability). Spaties rond een
 * deel tellen niet; een naam mag zelf wel spaties hebben.
 */
function leesInstellingen(tekst) {
  const delen = String(tekst ?? "").split(";").map((d) => d.trim()).filter(Boolean);
  const uit = { sleutel: delen[0] ?? "", thermostaat: delen[1] ?? "", kamersensor: "", volg: false, tsetApparaat: "", tsetCapability: "", ruimtes: null };
  for (const d of delen.slice(2)) {
    const [k, ...rest] = d.split("=");
    const v = rest.join("=").trim();
    const sleutel = k.trim().toLowerCase();
    if (sleutel === "volg") uit.volg = true;
    else if (sleutel === "kamer") uit.kamersensor = v;
    else if (sleutel === "ruimtes") {
      const zones = v.split(",").map((z) => z.trim()).filter(Boolean);
      uit.ruimtes = zones.length === 1 && zones[0].toLowerCase() === "alle" ? "alle" : zones.length ? zones : null;
    }
    else if (sleutel === "tset") {
      const i = v.lastIndexOf("/");
      if (i > 0) { uit.tsetApparaat = v.slice(0, i).trim(); uit.tsetCapability = v.slice(i + 1).trim(); }
    }
  }
  return uit;
}

function beginToestand() {
  return {
    wachtrij: [], toegepast: [], gemeld: [], blokken: [],
    plan_live: false, basis: null,
    sturing: { laatst_gezet: null, stuurt: false, plan_id: null, pauze_tot: null, handmatig: false },
    vorig_setpoint: null,
    laatste_sync: null, fouten: 0, opnieuw_om: null, laatste_fout: null, besluit: null,
    thermostaat_vingerafdruk: null, thermostaat_om: null,
    ruimte_wachtrij: [], ruimte_laatst: {}, ruimtes_ondersteund: null, ruimte_resultaat: null,
  };
}

/** sha256 als hex, zonder imports (HomeyScript kent geen require). */
function sha256Hex(tekst) {
  const K = [];
  for (let n = 2, i = 0; i < 64; n++) {
    let priem = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { priem = false; break; }
    if (priem) K[i++] = (Math.cbrt(n) % 1) * 2 ** 32 | 0;
  }
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bytes = [...unescape(encodeURIComponent(String(tekst)))].map((c) => c.charCodeAt(0));
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i > 3 ? 0 : (bits >>> (i * 8)) & 0xff);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let p = 0; p < bytes.length; p += 64) {
    const w = [];
    for (let i = 0; i < 16; i++) w[i] = (bytes[p + 4 * i] << 24) | (bytes[p + 4 * i + 1] << 16) | (bytes[p + 4 * i + 2] << 8) | bytes[p + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + t2) | 0];
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  return H.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

/** Vaste sleutel voor de site: een hash van het apparaat-id, dus hernoemen of verhuizen houdt de sensor. */
const ruimteSleutel = (id) => sha256Hex(id).slice(0, 16);

/** Wanneer een capability voor het laatst veranderde (Homey geeft een ISO-tekst), of null. */
function wanneer(cap) {
  const v = cap?.lastUpdated;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return typeof v === "string" ? tijd(v) : v instanceof Date ? v.getTime() : null;
}

/** Wat een ruimte nu meet: temperatuur, en wat erbij hoort, met het tijdstip van elke waarde. */
function ruimteMoment(r, gez) {
  const c = r.apparaat.capabilitiesObj ?? {};
  const m = {
    key: ruimteSleutel(r.id), naam: r.naam, verdieping: r.verdieping, apparaatNaam: r.apparaatNaam, zoneNaam: r.zoneNaam,
    temp: getal(c.measure_temperature?.value), sinds: wanneer(c.measure_temperature), tijden: [],
  };
  if (m.temp === null) return m;
  m.tijden.push(m.sinds);
  for (const [soort, cap] of Object.entries(RUIMTE_SOORTEN)) {
    const capObj = gez[soort]?.capabilitiesObj?.[cap];
    const v = getal(capObj?.value);
    if (v !== null) { m[soort] = v; m.tijden.push(wanneer(capObj)); }
  }
  return m;
}

function snoeiRuimtes(rij, sleutels, nu) {
  return rij.filter((r) => sleutels.has(r.key) && (tijd(r.measured_at) ?? 0) > nu - RUIMTE_WACHTRIJ_MAX_MS).slice(-RUIMTE_WACHTRIJ_MAX);
}

/**
 * Een meting per ruimte waarvan een waarde veranderde, met het tijdstip van die
 * verandering (de nieuwste van temperatuur, vocht, CO2 en luchtdruk). Nooit een
 * herhaling. Kent Homey geen tijdstip, dan telt alleen een andere waarde, op nu.
 */
function ruimtesInWachtrij(rij, laatst, momenten, nu) {
  const q = [...rij];
  const nieuw = {};
  for (const m of momenten) {
    const vorige = laatst?.[m.key] ?? null;
    if (vorige) nieuw[m.key] = vorige;
    if (m.temp === null) continue;
    const waarden = { temp: m.temp };
    for (const soort of Object.keys(RUIMTE_SOORTEN)) if (getal(m[soort]) !== null) waarden[soort] = Math.round(m[soort] * 100) / 100;
    waarden.temp = Math.round(m.temp * 100) / 100;
    const sig = JSON.stringify(waarden);
    const bekend = m.tijden.filter((t) => t !== null);
    let t = bekend.length ? Math.max(...bekend) : vorige?.sig !== sig ? nu : null;
    if (t === null) continue;
    t = Math.min(t, nu);
    if (vorige && t <= vorige.t) continue;
    q.push({ key: m.key, measured_at: new Date(t).toISOString(), ...waarden });
    nieuw[m.key] = { t, sig };
  }
  return [snoeiRuimtes(q, new Set(momenten.map((m) => m.key)), nu), nieuw];
}

/**
 * Het veld `rooms` voor één aanroep, en hoeveel metingen (van voren) erin zitten.
 * Elke gekozen ruimte gaat mee, ook zonder nieuwe meting: zo ziet de site een
 * nieuwe naam en dat de sensor er nog is.
 */
function ruimtesVoorAanroep(meta, rij) {
  const metingen = Object.fromEntries(meta.map((r) => [r.key, []]));
  let genomen = 0;
  for (const r of rij.slice(0, MAX_RUIMTE_METINGEN)) {
    if (!metingen[r.key]) break; // kan niet na snoeiRuimtes; nooit een meting overslaan
    const { key, ...meting } = r;
    metingen[key].push(meting);
    genomen++;
  }
  const rooms = meta.map((r) => ({ key: r.key, name: r.naam, ...(r.verdieping ? { floor: r.verdieping } : {}), readings: metingen[r.key] }));
  return [rooms, genomen];
}

/** Ruimtes waarvan de temperatuur twee uur niet veranderde of ontbreekt. */
function stilleRuimtes(momenten, nu) {
  return momenten.filter((m) => m.temp === null || (m.sinds !== null && nu - m.sinds > RUIMTE_STIL_MS))
    .map((m) => `"${m.apparaatNaam}"${m.zoneNaam ? ` (${m.zoneNaam})` : ""}`);
}

function meting(nu, velden, handmatig) {
  const m = { measured_at: iso(Math.floor(nu / 60_000) * 60_000), source: BRON };
  for (const [k, v] of Object.entries(velden)) if (getal(v) !== null) m[k] = Math.round(v * 1e4) / 1e4;
  if (handmatig) m.manual = true;
  return m;
}

function inWachtrij(rij, m, nu) {
  const q = [...rij];
  const laatste = q[q.length - 1];
  if (laatste && laatste.measured_at === m.measured_at) {
    q[q.length - 1] = laatste.manual || m.manual ? { ...m, manual: true } : m;
  } else q.push(m);
  return snoei(q, nu);
}

function snoei(rij, nu) {
  return rij.filter((m) => (tijd(m.measured_at) ?? 0) > nu - WACHTRIJ_MAX_MS).slice(-WACHTRIJ_MAX);
}

/** Het blok dat nu geldt: start <= nu < end; bij overlap het nieuwste created_at. */
function kiesBlok(blokken, nu) {
  let beste = null, besteGemaakt = -Infinity;
  for (const b of blokken ?? []) {
    const van = tijd(b.start), tot = tijd(b.end);
    if (van === null || tot === null || getal(Number(b.setpoint)) === null) continue;
    const gemaakt = b.created_at ? tijd(b.created_at) ?? -Infinity : -Infinity;
    if (van <= nu && nu < tot && gemaakt > besteGemaakt) { beste = b; besteGemaakt = gemaakt; }
  }
  return beste;
}

/**
 * Heeft iemand anders (een persoon, het eigen schema van de thermostaat, een
 * andere flow) het setpoint veranderd? Homey kent geen context zoals Home
 * Assistant, dus alleen vergelijken: wat we zelf het laatst schreven telt nooit.
 */
function handmatigVerzet(vorig, nieuw, laatstGezet) {
  if (nieuw === null) return false;
  if (vorig !== null && Math.abs(nieuw - vorig) < TOLERANTIE) return false;
  if (laatstGezet !== null && Math.abs(nieuw - laatstGezet) < TOLERANTIE) return false;
  return vorig !== null || laatstGezet !== null;
}

function pauzeer(sturing, nu) {
  return { ...sturing, pauze_tot: iso(nu + PAUZE_MS), handmatig: true, stuurt: false, plan_id: null, laatst_gezet: null };
}

/** Wat moet er nu naar de thermostaat? Nooit iets buiten 12-24 °C. */
function besluit(sturing, nu, { volg, planLive, blokken, basis, huidig, rond }) {
  const c = { ...sturing };
  const doel = (s) => klem(rond ? rond(klem(s)) : klem(s));
  if (c.pauze_tot && (tijd(c.pauze_tot) ?? 0) > nu) return [{ doel: null, plan_id: null, reden: "handmatig, pauze" }, c];
  c.pauze_tot = null;
  if (!volg) { c.stuurt = false; c.plan_id = null; return [{ doel: null, plan_id: null, reden: "plan volgen staat uit" }, c]; }
  const blok = planLive ? kiesBlok(blokken, nu) : null;
  if (blok) {
    const t = doel(blok.setpoint);
    Object.assign(c, { stuurt: true, plan_id: blok.plan_id ?? null, laatst_gezet: t });
    if (huidig === null || Math.abs(huidig - t) >= TOLERANTIE) return [{ doel: t, plan_id: c.plan_id, reden: `plan ${c.plan_id}` }, c];
    return [{ doel: null, plan_id: c.plan_id, reden: `plan ${c.plan_id} staat al` }, c];
  }
  if (c.stuurt) {
    c.stuurt = false; c.plan_id = null;
    if (basis === null) { c.laatst_gezet = null; return [{ doel: null, plan_id: null, reden: "geen plan, geen basis" }, c]; }
    const b = doel(basis);
    c.laatst_gezet = b;
    if (huidig !== null && Math.abs(huidig - b) < TOLERANTIE) return [{ doel: null, plan_id: null, reden: "geen plan, staat al op basis" }, c];
    return [{ doel: b, plan_id: null, reden: "geen plan, terug naar basis" }, c];
  }
  return [{ doel: null, plan_id: null, reden: "geen plan" }, c];
}

function bewaarAntwoord(s, a, nu) {
  s.fouten = 0; s.opnieuw_om = null; s.laatste_fout = null; s.laatste_sync = iso(nu);
  if (typeof a.plan_live === "boolean") s.plan_live = a.plan_live;
  if (getal(a.base_setpoint) !== null) s.basis = a.base_setpoint;
  if (Array.isArray(a.blocks)) s.blokken = a.blocks.filter((b) => b && typeof b === "object");
  s.blokken = s.blokken.filter((b) => (tijd(b.end) ?? Infinity) > nu);
}

/** Synchroniseren: de wachtrij leeg sturen, het antwoord bewaren, terugvallen na een fout. */
async function synchroniseer(s, nu, post, thermostaat, ruimteMeta = null) {
  if (s.opnieuw_om && (tijd(s.opnieuw_om) ?? 0) > nu) return;
  for (let i = 0; i < MAX_AANROEPEN; i++) {
    const metingen = s.wachtrij.slice(0, MAX_METINGEN);
    const toegepast = s.toegepast.slice(0, MAX_TOEGEPAST);
    const body = {};
    if (metingen.length) body.measurements = metingen;
    if (toegepast.length) body.applied = toegepast;
    if (thermostaat) body.thermostat = thermostaat;
    let genomen = 0;
    if (ruimteMeta) [body.rooms, genomen] = ruimtesVoorAanroep(ruimteMeta, s.ruimte_wachtrij);
    const { status, data } = await post(body);
    if (status === 401) { s.laatste_fout = "sleutel geweigerd"; throw new Error("Weheat Monitor weigert de sleutel"); }
    if (status === 400) {
      // De server neemt deze metingen nooit; bewaren zou de wachtrij blokkeren.
      s.wachtrij = s.wachtrij.slice(metingen.length);
      s.toegepast = s.toegepast.slice(toegepast.length);
      s.ruimte_wachtrij = s.ruimte_wachtrij.slice(genomen);
      s.laatste_fout = `HTTP 400: ${data?.error ?? "ongeldig"}`;
      if (!s.wachtrij.length && !s.toegepast.length && !genomen) return;
      continue;
    }
    if (status !== 200 || !data || typeof data !== "object") {
      s.fouten += 1;
      s.opnieuw_om = iso(nu + Math.min(60_000 * 2 ** (s.fouten - 1), MAX_WACHT_MS) - 1000);
      s.laatste_fout = status ? `HTTP ${status}` : "geen verbinding";
      return;
    }
    s.wachtrij = s.wachtrij.slice(metingen.length);
    s.toegepast = s.toegepast.slice(toegepast.length);
    bewaarAntwoord(s, data, nu);
    // Een site die `rooms` nog niet kent, antwoordt zonder `rooms`: dan blijven de metingen wachten.
    let ruimtesDoor = false;
    if (ruimteMeta) {
      s.ruimtes_ondersteund = !!(data.rooms && typeof data.rooms === "object");
      if (s.ruimtes_ondersteund) {
        s.ruimte_wachtrij = s.ruimte_wachtrij.slice(genomen);
        s.ruimte_resultaat = data.rooms;
        ruimtesDoor = genomen > 0 && s.ruimte_wachtrij.length > 0;
      }
    }
    if (thermostaat) {
      s.thermostaat_vingerafdruk = JSON.stringify(thermostaat);
      s.thermostaat_om = iso(nu);
      thermostaat = null;
    }
    if (!s.wachtrij.length && !s.toegepast.length && !ruimtesDoor) return;
  }
}

/**
 * Eén minuut: handmatig verzet herkennen, meting in de wachtrij, synchroniseren,
 * dan sturen. `thermo` is wat we van de thermostaat lezen, `zet` schrijft hem.
 */
async function minuut(s, nu, { velden, thermo, post, zet, volg, ruimtes = null }) {
  const huidig = thermo?.setpoint ?? null;
  if (handmatigVerzet(s.vorig_setpoint, huidig, s.sturing.laatst_gezet)) s.sturing = pauzeer(s.sturing, nu);

  // Zonder één waarde (bijvoorbeeld vlak na een herstart van Homey) is er niets
  // gemeten: geen meting, en een handmatig verzet gaat mee met de volgende.
  if (Object.values(velden).some((v) => getal(v) !== null)) {
    const handmatig = s.sturing.handmatig;
    s.sturing = { ...s.sturing, handmatig: false };
    s.wachtrij = inWachtrij(s.wachtrij, meting(nu, velden, handmatig), nu);
  }

  const info = thermo?.info ?? null;
  const melden = info && (s.thermostaat_vingerafdruk !== JSON.stringify(info) ||
    !s.thermostaat_om || (tijd(s.thermostaat_om) ?? 0) <= nu - THERMOSTAAT_MELDEN_MS) ? info : null;
  // Ruimtes: zonder `ruimtes=` gaat er niets mee en vervalt wat nog wachtte.
  let ruimteMeta = null;
  if (ruimtes && ruimtes.length) {
    [s.ruimte_wachtrij, s.ruimte_laatst] = ruimtesInWachtrij(s.ruimte_wachtrij, s.ruimte_laatst, ruimtes, nu);
    ruimteMeta = ruimtes.map((m) => ({ key: m.key, naam: m.naam, verdieping: m.verdieping }));
  } else {
    s.ruimte_wachtrij = []; s.ruimte_laatst = {};
  }
  await synchroniseer(s, nu, post, melden, ruimteMeta);

  // De waarde van vóór het schrijven: een cloudthermostaat die over een minuut
  // nog de oude waarde meldt, is dan geen handmatig verzet.
  s.vorig_setpoint = huidig;
  if (!thermo || huidig === null) { s.besluit = "thermostaat niet beschikbaar"; return s.besluit; }
  const [b, sturing] = besluit(s.sturing, nu, {
    volg, planLive: s.plan_live, blokken: s.blokken, basis: s.basis, huidig, rond: thermo.rond,
  });
  s.sturing = sturing;
  s.besluit = b.reden;
  if (b.doel !== null) {
    try {
      await zet(b.doel);
    } catch (e) {
      s.besluit = `${b.reden} (zetten mislukt: ${e?.message ?? e})`;
      return s.besluit;
    }
  }
  if (b.plan_id !== null && !s.gemeld.includes(b.plan_id)) {
    s.toegepast.push(b.plan_id);
    s.gemeld = [...s.gemeld, b.plan_id].slice(-50);
  }
  return s.besluit;
}

/**
 * Wat er in de Homey-tijdlijn moet, alleen bij een verandering: de eerste keer
 * verbonden, een storing die een kwartier duurt (een geweigerde sleutel meteen),
 * weer verbonden na zo'n melding, en een instelling die niet klopt. Werkt de
 * toestand bij en geeft de teksten terug.
 */
function meldingen(m, nu, { verbonden, fout, probleem, kamer, setpoint, stil = [] }) {
  const uit = [];
  if (fout) {
    m.fout_sinds ??= nu;
    if (!m.fout_gemeld && (fout === "sleutel geweigerd" || nu - m.fout_sinds >= STORING_MELDEN_MS)) {
      uit.push(fout === "sleutel geweigerd"
        ? "❌ Weheat Monitor: weheat-monitor.nl weigert de sleutel. Maak een nieuwe koppeling en zet de sleutel in de flow."
        : `⚠️ Weheat Monitor: weheat-monitor.nl niet bereikbaar sinds ${new Date(m.fout_sinds).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Amsterdam" })} (${fout}). De metingen wachten tot 24 uur.`);
      m.fout_gemeld = true;
    }
  } else if (verbonden) {
    const waarden = [kamer !== null ? `kamer ${kamer} °C` : null, setpoint !== null ? `setpoint ${setpoint} °C` : null].filter(Boolean).join(", ");
    if (!m.verbonden) uit.push(`✅ Weheat Monitor: verbonden met weheat-monitor.nl${waarden ? ` (${waarden})` : ""}. Vanaf nu elke minuut een meting.`);
    else if (m.fout_gemeld) uit.push("✅ Weheat Monitor: weer verbonden. De bewaarde metingen zijn verstuurd.");
    m.verbonden = true; m.fout_gemeld = false; m.fout_sinds = null;
  }
  if ((probleem || null) !== (m.probleem ?? null)) {
    if (probleem) uit.push(`⚠️ Weheat Monitor: ${probleem}. Draai controle.js om de namen in Homey te zien.`);
    m.probleem = probleem || null;
  }
  // Een ruimtesensor die stil valt: één keer, en pas weer als hij eerst gemeten heeft.
  const eerder = Array.isArray(m.stil) ? m.stil : [];
  const nieuwStil = stil.filter((n) => !eerder.includes(n));
  if (nieuwStil.length) {
    uit.push(`⚠️ Weheat Monitor: al twee uur geen nieuwe temperatuur van ${nieuwStil.join(", ")}. Lege batterij of buiten bereik? ` +
      "Die ruimte krijgt geen metingen tot de sensor weer meet.");
  }
  m.stil = stil;
  return uit;
}

// ─── Homey ──────────────────────────────────────────────────────────────────

/** Een regel in de Homey-tijdlijn. Lukt dat niet, dan gaat het script gewoon door. */
async function inTijdlijn(tekst) {
  for (const id of ["homey:manager:notifications:create_notification", "create_notification"]) {
    try {
      await Homey.flow.runFlowCardAction({ uri: "homey:manager:notifications", id, args: { text: tekst } });
      return true;
    } catch { /* andere vorm van de Homey-API, of geen tijdlijn: volgende proberen */ }
  }
  log(tekst);
  return false;
}

/** Een apparaat op naam of id. */
async function zoekApparaat(naamOfId) {
  if (!naamOfId) return null;
  const alle = Object.values(await Homey.devices.getDevices());
  return alle.find((d) => d.id === naamOfId) ?? alle.find((d) => d.name === naamOfId) ?? null;
}

const waarde = (apparaat, cap) => getal(apparaat?.capabilitiesObj?.[cap]?.value);

/** Wat we over de thermostaat melden: app, driver, stap, grenzen. Geen naam, geen id. */
function thermostaatInfo(apparaat) {
  const info = {};
  const m = /^homey:app:([^:]+):(.+)$/.exec(apparaat.driverId ?? apparaat.driverUri ?? "");
  if (m) {
    info.integration = `homey_${m[1]}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
    info.model = m[2].slice(0, 80);
  }
  const doel = apparaat.capabilitiesObj?.target_temperature ?? {};
  if (getal(doel.step) !== null) info.target_temp_step = doel.step;
  if (getal(doel.min) !== null) info.min_temp = doel.min;
  if (getal(doel.max) !== null) info.max_temp = doel.max;
  const modi = apparaat.capabilitiesObj?.thermostat_mode?.values;
  if (Array.isArray(modi)) info.hvac_modes = modi.map((v) => String(v?.id ?? v).toLowerCase()).filter((v) => /^[a-z_]{1,20}$/.test(v));
  return Object.keys(info).length ? info : null;
}

/** Afronden op wat de thermostaat kan tonen: zijn stap en grenzen. */
function rondVoor(apparaat) {
  const doel = apparaat.capabilitiesObj?.target_temperature ?? {};
  return (t) => {
    let v = t;
    if (getal(doel.step) && doel.step > 0) v = Math.round(Math.round(v / doel.step) * doel.step * 100) / 100;
    if (getal(doel.min) !== null) v = Math.max(v, doel.min);
    if (getal(doel.max) !== null) v = Math.min(v, doel.max);
    return v;
  };
}

// HomeyScript kent geen AbortController; de tijdslimiet is daarom een race.
// Het verzoek zelf loopt dan nog door, maar het script wacht er niet op.
async function post(body, sleutel) {
  let klok = null;
  const tijdslimiet = typeof setTimeout === "function"
    ? new Promise((klaar) => { klok = setTimeout(() => klaar({ status: 0, data: null }), TIMEOUT_MS); })
    : null;
  const verzoek = (async () => {
    try {
      const r = await fetch(ADRES, {
        method: "POST",
        headers: { Authorization: `Bearer ${sleutel}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let data = null;
      try { data = await r.json(); } catch { data = null; }
      return { status: r.status, data };
    } catch {
      return { status: 0, data: null };
    }
  })();
  try {
    return await (tijdslimiet ? Promise.race([verzoek, tijdslimiet]) : verzoek);
  } finally {
    if (klok !== null && typeof clearTimeout === "function") clearTimeout(klok);
  }
}

async function hoofd() {
  const ik = leesInstellingen(typeof args !== "undefined" && Array.isArray(args) ? args[0] : "");
  if (!/^(whm_)?[0-9a-f]{64}$/.test(ik.sleutel)) {
    throw new Error("Geen geldige sleutel. Start het script vanuit een flow met \"Voer een script uit met argument\", argument: whm_...;naam van je thermostaat.");
  }
  const nu = Date.now();
  let s = beginToestand();
  try { Object.assign(s, JSON.parse(global.get(OPSLAG) || "{}")); } catch { /* lege toestand */ }
  s.sturing = { ...beginToestand().sturing, ...s.sturing };
  s.wachtrij = snoei(s.wachtrij, nu);

  const thermostaat = await zoekApparaat(ik.thermostaat);
  const kamersensor = await zoekApparaat(ik.kamersensor);
  const tset = await zoekApparaat(ik.tsetApparaat);
  if (!thermostaat) log(`Thermostaat "${ik.thermostaat}" niet gevonden; alleen de wachtrij wordt verstuurd.`);
  // Een kamersensor die niet (meer) bestaat of geen temperatuur geeft: terug naar de thermostaat, en zeggen.
  const sensorMist = ik.kamersensor && waarde(kamersensor, "measure_temperature") === null
    ? `kamersensor "${ik.kamersensor}" ${kamersensor ? "geeft geen temperatuur" : "niet gevonden"}, kamer van de thermostaat` : "";

  const velden = {
    room_temp: waarde(kamersensor, "measure_temperature") ?? waarde(thermostaat, "measure_temperature"),
    setpoint: waarde(thermostaat, "target_temperature"),
    boiler_setpoint: ik.tsetCapability ? waarde(tset, ik.tsetCapability) : null,
  };
  // Ruimtes: elke temperatuursensor uit `ruimtes=`, met vocht, CO2 en luchtdruk erbij.
  let ruimtes = null, ruimteProbleem = "", gekozen = { ruimtes: [], teVeel: 0, onbekend: [] };
  if (ik.ruimtes) {
    const apparaten = Object.values(await Homey.devices.getDevices());
    let zones = {};
    try { zones = (await Homey.zones?.getZones?.()) ?? {}; } catch { zones = {}; }
    gekozen = kiesRuimtes(apparaten, zones, ik.ruimtes);
    ruimtes = gekozen.ruimtes.map((r) => ruimteMoment(r, metgezellen(r, apparaten)));
    ruimteProbleem = [
      gekozen.onbekend.length ? `zone ${gekozen.onbekend.map((z) => `"${z}"`).join(", ")} uit ruimtes= niet gevonden` : "",
      !gekozen.onbekend.length && !gekozen.ruimtes.length ? "geen temperatuursensor gevonden voor ruimtes=" : "",
      gekozen.teVeel ? `${gekozen.teVeel} temperatuursensor(en) te veel voor ruimtes=, de eerste ${MAX_RUIMTES} gaan mee` : "",
    ].filter(Boolean).join("; ");
  }

  const thermo = thermostaat && waarde(thermostaat, "target_temperature") !== null ? {
    setpoint: waarde(thermostaat, "target_temperature"),
    info: thermostaatInfo(thermostaat),
    rond: rondVoor(thermostaat),
  } : null;
  const zet = (doel) => Homey.devices.setCapabilityValue({ deviceId: thermostaat.id, capabilityId: "target_temperature", value: doel });

  let mislukt = null;
  try {
    await minuut(s, nu, { velden, thermo, post: (body) => post(body, ik.sleutel), zet, volg: ik.volg, ruimtes });
  } catch (e) {
    mislukt = e;
  }
  // Instellingen die niet kloppen: in de tijdlijn, en de flowkaart wordt rood.
  const instelling = !thermostaat ? `thermostaat "${ik.thermostaat}" niet gevonden in Homey`
    : !thermostaat.capabilitiesObj?.target_temperature ? `"${ik.thermostaat}" heeft geen ingestelde temperatuur (target_temperature)` : "";
  s.melding = s.melding && typeof s.melding === "object" ? s.melding : {};
  const teksten = meldingen(s.melding, nu, {
    verbonden: s.laatste_sync !== null, fout: s.laatste_fout,
    probleem: [instelling || sensorMist.replace(/, kamer van de thermostaat$/, ""), ruimteProbleem].filter(Boolean).join("; "),
    kamer: velden.room_temp, setpoint: velden.setpoint, stil: ruimtes ? stilleRuimtes(ruimtes, nu) : [],
  });
  global.set(OPSLAG, JSON.stringify(s));
  for (const t of teksten) await inTijdlijn(t);
  if (mislukt) throw mislukt;
  if (instelling) throw new Error(`${instelling}. Controleer de naam in het argument van de flow (hoofdletters en spaties tellen mee).`);

  const blok = kiesBlok(s.blokken, nu);
  const waarom = !thermo ? `"${ik.thermostaat}" geeft nog geen setpoint` : s.besluit;
  return `v${VERSIE}: ${waarom}; wachtrij ${s.wachtrij.length}` +
    (sensorMist ? `; ${sensorMist}` : "") +
    (ruimtes ? `; ruimtes ${ruimtes.length - stilleRuimtes(ruimtes, nu).length} van ${ruimtes.length} meten` +
      (s.ruimtes_ondersteund === false ? ", site kent ruimtes nog niet" : "") +
      (s.ruimte_wachtrij.length ? `, ${s.ruimte_wachtrij.length} wachten` : "") : "") +
    (blok ? `; blok ${blok.setpoint} °C tot ${blok.end}` : "") +
    (s.laatste_fout ? `; fout: ${s.laatste_fout}` : "");
}

return await hoofd();
