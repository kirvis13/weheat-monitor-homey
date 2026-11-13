// Weheat Monitor voor Homey: controle vooraf
// https://github.com/kirvis13/weheat-monitor-homey
//
// Draai dit in een los HomeyScript, vóór je de flow maakt: vul hieronder in wat
// je weet en druk op Test. Het controleert je sleutel bij weheat-monitor.nl,
// zoekt je thermostaten en temperatuursensoren en zet onderaan precies wat je
// in de flow invult. Weet je een naam nog niet, laat hem leeg: de uitvoer
// noemt alle namen, zodat je er een kunt kopiëren en opnieuw op Test drukt.
// Het verandert niets aan je thermostaat; de site ziet alleen dat de koppeling
// "gezien" is.

const SLEUTEL = "whm_...";   // van weheat-monitor.nl/settings/connections
const THERMOSTAAT = "";      // de thermostaat die je warmtepomp aanstuurt (leeg = de enige die er is)
const KAMERSENSOR = "";      // optioneel: een losse thermometer die de kamer beter meet
const VOLG_PLAN = false;     // true: de thermostaat volgt het plan van de site (en de thermostaattest)
const RUIMTES = "";          // optioneel: "alle", of zones met komma's ertussen ("Slaapkamer achter,Zolder")

const ADRES = "https://www.weheat-monitor.nl/api/v1/devices/sync";
const TIMEOUT_MS = 10_000;

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

async function vraag() {
  let klok = null;
  const tijdslimiet = typeof setTimeout === "function"
    ? new Promise((klaar) => { klok = setTimeout(() => klaar({ status: 0, data: null }), TIMEOUT_MS); })
    : null;
  const verzoek = (async () => {
    try {
      const r = await fetch(ADRES, {
        method: "POST",
        headers: { Authorization: `Bearer ${SLEUTEL.trim()}`, "Content-Type": "application/json" },
        body: "{}",
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


async function controle() {
  // HomeyScript toont een teruggegeven tekst als één regel met \n erin; wat met
  // log() gaat, staat er netjes onder elkaar. Dus: alles loggen, kort teruggeven.
  const schrijf = typeof log === "function" ? log : console.log;
  const regels = ["Weheat Monitor: controle", ""];
  const goed = (t) => regels.push(`✅ ${t}`);
  const fout = (t) => regels.push(`❌ ${t}`);
  let alles = true;
  const graden = (v) => (typeof v === "number" ? `${v} °C` : "onbekend");

  // 1. De sleutel
  const sleutel = SLEUTEL.trim();
  if (!/^(whm_)?[0-9a-f]{64}$/.test(sleutel)) {
    fout("Sleutel: vul bovenin je sleutel in (whm_ plus 64 tekens).");
    alles = false;
  } else {
    const { status, data } = await vraag();
    if (status === 200 && data && typeof data === "object") {
      goed(`Sleutel geaccepteerd door weheat-monitor.nl. Plan voor deze koppeling: ${data.plan_live ? "aan" : "uit"}.`);
    } else if (status === 401) {
      fout("Sleutel geweigerd: ingetrokken of verkeerd overgenomen. Maak zo nodig een nieuwe koppeling.");
      alles = false;
    } else {
      fout(`Site niet bereikbaar (${status ? `HTTP ${status}` : "geen verbinding"}). Probeer het over een paar minuten opnieuw.`);
      alles = false;
    }
  }

  // 2. Wat er in Homey is: thermostaten (met een ingestelde temperatuur) en losse thermometers
  const apparaten = Object.values(await Homey.devices.getDevices());
  const opNaam = (a, b) => String(a.name).localeCompare(String(b.name));
  const thermostaten = apparaten.filter((d) => d.capabilitiesObj?.target_temperature).sort(opNaam);
  const keer = (naam) => apparaten.filter((d) => d.name === naam).length;
  const dubbel = (naam) => `De naam "${naam}" staat ${keer(naam)} keer in Homey. Geef het juiste apparaat in Homey een eigen naam en vul die in.`;
  const sensoren = apparaten
    .filter((d) => d.capabilitiesObj?.measure_temperature && !d.capabilitiesObj?.target_temperature)
    .sort(opNaam);

  // 3. De thermostaat
  const gevraagd = THERMOSTAAT.trim();
  let thermostaat = null;
  if (gevraagd) {
    thermostaat = apparaten.find((d) => d.name === gevraagd) ?? null;
    if (!thermostaat) fout(`Thermostaat "${gevraagd}" niet gevonden. Neem de naam precies over uit de lijst hieronder.`);
    else if (keer(gevraagd) > 1) { fout(dubbel(gevraagd)); thermostaat = null; }
    else if (!thermostaat.capabilitiesObj?.target_temperature) {
      fout(`"${gevraagd}" heeft geen ingestelde temperatuur (target_temperature), dus is geen thermostaat. Kies er een uit de lijst hieronder.`);
      thermostaat = null;
    }
  } else if (thermostaten.length === 1) {
    thermostaat = thermostaten[0];
  } else if (thermostaten.length > 1) {
    fout("Er zijn meerdere thermostaten. Zet bij THERMOSTAAT de naam van degene die je warmtepomp aanstuurt (zie de lijst hieronder).");
  } else {
    fout("Geen thermostaat gevonden: geen enkel apparaat in Homey heeft een ingestelde temperatuur (target_temperature).");
  }
  if (thermostaat) {
    const sp = thermostaat.capabilitiesObj.target_temperature?.value;
    const app = /^homey:app:([^:]+):/.exec(thermostaat.driverId ?? thermostaat.driverUri ?? "")?.[1] ?? "onbekende app";
    if (typeof sp !== "number") { fout(`Thermostaat "${thermostaat.name}" (${app}) geeft (nog) geen setpoint.`); thermostaat = null; }
    else goed(`Thermostaat "${thermostaat.name}" (${app}): setpoint ${graden(sp)}, kamer ${graden(thermostaat.capabilitiesObj.measure_temperature?.value)}.`);
  }
  if (!thermostaat) alles = false;

  // 4. De kamersensor (optioneel)
  const kamer = KAMERSENSOR.trim();
  if (kamer) {
    const d = apparaten.find((x) => x.name === kamer);
    const t = d?.capabilitiesObj?.measure_temperature?.value;
    if (!d) fout(`Kamersensor "${kamer}" niet gevonden. Neem de naam precies over uit de lijst hieronder.`);
    else if (keer(kamer) > 1) fout(dubbel(kamer));
    else if (typeof t !== "number") fout(`Kamersensor "${kamer}" geeft (nog) geen temperatuur.`);
    else goed(`Kamersensor "${kamer}": ${graden(t)}.`);
    if (!d || keer(kamer) > 1 || typeof t !== "number") alles = false;
  }

  // 5. Ruimtes (optioneel): welke temperatuursensoren meegaan, met wat erbij hoort
  let zones = {};
  try { zones = (await Homey.zones?.getZones?.()) ?? {}; } catch { zones = {}; }
  const alleRuimtes = kiesRuimtes(apparaten, zones, "alle");
  const ruimteKeuze = (() => {
    const lijst = RUIMTES.split(",").map((z) => z.trim()).filter(Boolean);
    return lijst.length === 1 && lijst[0].toLowerCase() === "alle" ? "alle" : lijst.length ? lijst : null;
  })();
  const gekozen = kiesRuimtes(apparaten, zones, ruimteKeuze);
  const meet = (r) => {
    const gez = metgezellen(r, apparaten);
    const v = (soort, eenheid) => {
      const w = gez[soort]?.capabilitiesObj?.[RUIMTE_SOORTEN[soort]]?.value;
      return typeof w === "number" ? `${w} ${eenheid}` : null;
    };
    return [graden(r.apparaat.capabilitiesObj.measure_temperature?.value), v("humidity", "%"), v("co2", "ppm"), v("pressure", "hPa")]
      .filter(Boolean).join(", ");
  };
  if (ruimteKeuze) {
    if (gekozen.onbekend.length) {
      fout(`Ruimtes: zone ${gekozen.onbekend.map((z) => `"${z}"`).join(", ")} niet gevonden. Neem de naam van de zone precies over uit de lijst hieronder.`);
      alles = false;
    } else if (!gekozen.ruimtes.length) {
      fout("Ruimtes: geen temperatuursensor gevonden in die zones (een thermostaat of radiatorkraan telt niet, buiten ook niet).");
      alles = false;
    } else {
      goed(`Ruimtes: ${gekozen.ruimtes.length} ${gekozen.ruimtes.length === 1 ? "sensor gaat" : "sensoren gaan"} mee naar weheat-monitor.nl:`);
      for (const r of gekozen.ruimtes) regels.push(`    ${r.naam}${r.verdieping ? ` (${r.verdieping})` : ""}: ${meet(r)}  [${r.apparaatNaam}]`);
      if (gekozen.teVeel) regels.push(`⚠️ Ruimtes: ${gekozen.teVeel} sensor(en) te veel; hooguit ${MAX_RUIMTES} gaan mee. Noem bij RUIMTES alleen de zones die je wilt.`);
    }
  }

  // 6. Bewaren tussen twee runs
  const proef = `controle-${Date.now()}`;
  try {
    global.set("weheat_monitor_controle", proef);
    if (global.get("weheat_monitor_controle") === proef) goed("HomeyScript kan de toestand bewaren.");
    else { fout("HomeyScript bewaart niets tussen twee runs."); alles = false; }
    global.set("weheat_monitor_controle", null);
  } catch (e) {
    fout(`HomeyScript kan niets bewaren: ${e?.message ?? e}`);
    alles = false;
  }

  // 7. De Homey-tijdlijn: daar meldt het script of het verbonden is
  let tijdlijn = false;
  for (const id of ["homey:manager:notifications:create_notification", "create_notification"]) {
    try {
      await Homey.flow.runFlowCardAction({ uri: "homey:manager:notifications", id, args: { text: "✅ Weheat Monitor: controle gedaan, de tijdlijn werkt." } });
      tijdlijn = true;
      break;
    } catch { /* andere vorm van de Homey-API: volgende proberen */ }
  }
  if (tijdlijn) goed("HomeyScript kan in de tijdlijn schrijven: daar zie je straks of het script verbonden is.");
  else regels.push("⚠️ HomeyScript kan niet in de tijdlijn schrijven. Het script werkt wel, maar meldt dan niets in de tijdlijn.");

  // 8. Alle namen, om uit te kopiëren
  const lijst = (d, wat) => `  • "${d.name}": ${wat}${keer(d.name) > 1 ? "  ⚠️ naam staat dubbel in Homey" : ""}`;
  regels.push("", "Thermostaten in Homey (voor THERMOSTAAT):");
  for (const d of thermostaten) regels.push(lijst(d, `setpoint ${graden(d.capabilitiesObj.target_temperature?.value)}`));
  if (!thermostaten.length) regels.push("  (geen)");
  regels.push("", "Thermometers in Homey (voor KAMERSENSOR, optioneel):");
  for (const d of sensoren) regels.push(lijst(d, graden(d.capabilitiesObj.measure_temperature?.value)));
  if (!sensoren.length) regels.push("  (geen)");
  regels.push("", "Ruimtes in Homey, per zone (voor RUIMTES, optioneel):");
  for (const r of alleRuimtes.ruimtes) regels.push(`  • "${r.zoneNaam || r.naam}": "${r.apparaatNaam}" ${meet(r)}`);
  for (const r of alleRuimtes.buiten) regels.push(`  • "${r.zoneNaam || r.apparaatNaam}": "${r.apparaatNaam}" buiten, gaat nooit mee`);
  if (!alleRuimtes.ruimtes.length && !alleRuimtes.buiten.length) regels.push("  (geen)");

  // 9. De flow
  regels.push("");
  if (!alles) {
    regels.push("Los eerst de regels met ❌ op en druk opnieuw op Test. Dan staat hier wat je in de flow invult.");
    schrijf(regels.join("\n"));
    return "Nog niet in orde: zie de ❌-regels hierboven.";
  }
  const argument = [sleutel, thermostaat.name, ...(VOLG_PLAN ? ["volg"] : []), ...(kamer ? [`kamer=${kamer}`] : []),
    ...(ruimteKeuze ? [`ruimtes=${ruimteKeuze === "alle" ? "alle" : ruimteKeuze.join(",")}`] : [])].join(";");
  regels.push(
    "Alles in orde. Zo bouw je de flow:",
    "  • Als: Datum en tijd, Elke 1 minuut",
    "  • Dan: HomeyScript, Voer een script uit met argument",
    "  • Script: weheat-monitor",
    "  • Argument: kopieer de regel hieronder",
    "",
    argument,
    "",
    `Plan volgen: ${VOLG_PLAN ? "aan (volg)" : "uit. Zet VOLG_PLAN op true als de site je thermostaat mag sturen"}.`,
    "Let op: het argument bevat je sleutel. Deel de uitvoer niet zonder die regel weg te halen.",
  );
  schrijf(regels.join("\n"));
  return "Alles in orde: neem het flowblok hierboven over.";
}

return await controle();
