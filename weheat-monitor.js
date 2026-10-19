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
//
// Een update is dus: het hele script vervangen door de nieuwe versie. Uitleg:
// README.md in de repository.
//
// Het script praat alleen met weheat-monitor.nl, nooit met Weheat zelf. De
// sleutel gaat alleen in de Authorization-kop mee en komt nooit in het log.

const VERSIE = "0.3.0";

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
  const uit = { sleutel: delen[0] ?? "", thermostaat: delen[1] ?? "", kamersensor: "", volg: false, tsetApparaat: "", tsetCapability: "" };
  for (const d of delen.slice(2)) {
    const [k, ...rest] = d.split("=");
    const v = rest.join("=").trim();
    const sleutel = k.trim().toLowerCase();
    if (sleutel === "volg") uit.volg = true;
    else if (sleutel === "kamer") uit.kamersensor = v;
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
  };
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
async function synchroniseer(s, nu, post, thermostaat) {
  if (s.opnieuw_om && (tijd(s.opnieuw_om) ?? 0) > nu) return;
  for (let i = 0; i < MAX_AANROEPEN; i++) {
    const metingen = s.wachtrij.slice(0, MAX_METINGEN);
    const toegepast = s.toegepast.slice(0, MAX_TOEGEPAST);
    const body = {};
    if (metingen.length) body.measurements = metingen;
    if (toegepast.length) body.applied = toegepast;
    if (thermostaat) body.thermostat = thermostaat;
    const { status, data } = await post(body);
    if (status === 401) { s.laatste_fout = "sleutel geweigerd"; throw new Error("Weheat Monitor weigert de sleutel"); }
    if (status === 400) {
      // De server neemt deze metingen nooit; bewaren zou de wachtrij blokkeren.
      s.wachtrij = s.wachtrij.slice(metingen.length);
      s.toegepast = s.toegepast.slice(toegepast.length);
      s.laatste_fout = `HTTP 400: ${data?.error ?? "ongeldig"}`;
      if (!s.wachtrij.length && !s.toegepast.length) return;
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
    if (thermostaat) {
      s.thermostaat_vingerafdruk = JSON.stringify(thermostaat);
      s.thermostaat_om = iso(nu);
      thermostaat = null;
    }
    if (!s.wachtrij.length && !s.toegepast.length) return;
  }
}

/**
 * Eén minuut: handmatig verzet herkennen, meting in de wachtrij, synchroniseren,
 * dan sturen. `thermo` is wat we van de thermostaat lezen, `zet` schrijft hem.
 */
async function minuut(s, nu, { velden, thermo, post, zet, volg }) {
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
  await synchroniseer(s, nu, post, melden);

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
function meldingen(m, nu, { verbonden, fout, probleem, kamer, setpoint }) {
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
  const thermo = thermostaat && waarde(thermostaat, "target_temperature") !== null ? {
    setpoint: waarde(thermostaat, "target_temperature"),
    info: thermostaatInfo(thermostaat),
    rond: rondVoor(thermostaat),
  } : null;
  const zet = (doel) => Homey.devices.setCapabilityValue({ deviceId: thermostaat.id, capabilityId: "target_temperature", value: doel });

  let mislukt = null;
  try {
    await minuut(s, nu, { velden, thermo, post: (body) => post(body, ik.sleutel), zet, volg: ik.volg });
  } catch (e) {
    mislukt = e;
  }
  // Instellingen die niet kloppen: in de tijdlijn, en de flowkaart wordt rood.
  const instelling = !thermostaat ? `thermostaat "${ik.thermostaat}" niet gevonden in Homey`
    : !thermostaat.capabilitiesObj?.target_temperature ? `"${ik.thermostaat}" heeft geen ingestelde temperatuur (target_temperature)` : "";
  s.melding = s.melding && typeof s.melding === "object" ? s.melding : {};
  const teksten = meldingen(s.melding, nu, {
    verbonden: s.laatste_sync !== null, fout: s.laatste_fout, probleem: instelling || sensorMist.replace(/, kamer van de thermostaat$/, ""),
    kamer: velden.room_temp, setpoint: velden.setpoint,
  });
  global.set(OPSLAG, JSON.stringify(s));
  for (const t of teksten) await inTijdlijn(t);
  if (mislukt) throw mislukt;
  if (instelling) throw new Error(`${instelling}. Controleer de naam in het argument van de flow (hoofdletters en spaties tellen mee).`);

  const blok = kiesBlok(s.blokken, nu);
  const waarom = !thermo ? `"${ik.thermostaat}" geeft nog geen setpoint` : s.besluit;
  return `v${VERSIE}: ${waarom}; wachtrij ${s.wachtrij.length}` +
    (sensorMist ? `; ${sensorMist}` : "") +
    (blok ? `; blok ${blok.setpoint} °C tot ${blok.end}` : "") +
    (s.laatste_fout ? `; fout: ${s.laatste_fout}` : "");
}

return await hoofd();
