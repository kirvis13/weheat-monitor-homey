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

const ADRES = "https://www.weheat-monitor.nl/api/v1/devices/sync";
const TIMEOUT_MS = 10_000;

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

  // 5. Bewaren tussen twee runs
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

  // 6. Alle namen, om uit te kopiëren
  const lijst = (d, wat) => `  • "${d.name}": ${wat}${keer(d.name) > 1 ? "  ⚠️ naam staat dubbel in Homey" : ""}`;
  regels.push("", "Thermostaten in Homey (voor THERMOSTAAT):");
  for (const d of thermostaten) regels.push(lijst(d, `setpoint ${graden(d.capabilitiesObj.target_temperature?.value)}`));
  if (!thermostaten.length) regels.push("  (geen)");
  regels.push("", "Thermometers in Homey (voor KAMERSENSOR, optioneel):");
  for (const d of sensoren) regels.push(lijst(d, graden(d.capabilitiesObj.measure_temperature?.value)));
  if (!sensoren.length) regels.push("  (geen)");

  // 7. De flow
  regels.push("");
  if (!alles) {
    regels.push("Los eerst de regels met ❌ op en druk opnieuw op Test. Dan staat hier wat je in de flow invult.");
    schrijf(regels.join("\n"));
    return "Nog niet in orde: zie de ❌-regels hierboven.";
  }
  const argument = [sleutel, thermostaat.name, ...(VOLG_PLAN ? ["volg"] : []), ...(kamer ? [`kamer=${kamer}`] : [])].join(";");
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
