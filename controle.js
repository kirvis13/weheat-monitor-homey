// Weheat Monitor voor Homey: controle vooraf
// https://github.com/kirvis13/weheat-monitor-homey
//
// Draai dit één keer in een los HomeyScript, vóór je de flow maakt: vul je
// sleutel hieronder in en druk op Test. Het controleert je sleutel bij
// weheat-monitor.nl, zoekt je thermostaten en temperatuursensoren en geeft de
// regel die je als argument in de flow zet. Het verandert niets aan je thermostaat; de site
// ziet alleen dat de koppeling "gezien" is.

const SLEUTEL = "whm_...";            // van weheat-monitor.nl/settings/connections
const KAMERSENSOR = "";               // optioneel: naam van een losse temperatuursensor, zoals hieronder in de lijst

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
  const regels = [];
  const goed = (t) => regels.push(`OK    ${t}`);
  const fout = (t) => regels.push(`FOUT  ${t}`);
  let alles = true;

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

  // 2. Thermostaten: alles met een ingestelde temperatuur
  const apparaten = Object.values(await Homey.devices.getDevices());
  const thermostaten = apparaten.filter((d) => d.capabilitiesObj?.target_temperature);
  if (!thermostaten.length) {
    fout("Geen thermostaat gevonden: geen enkel apparaat in Homey heeft een ingestelde temperatuur (target_temperature).");
    alles = false;
  } else {
    for (const d of thermostaten) {
      const sp = d.capabilitiesObj.target_temperature?.value;
      const kamer = d.capabilitiesObj.measure_temperature?.value;
      const app = /^homey:app:([^:]+):/.exec(d.driverId ?? d.driverUri ?? "")?.[1] ?? "onbekende app";
      const waarden = sp == null ? "nog geen setpoint" : `setpoint ${sp} °C, kamer ${kamer ?? "onbekend"} °C`;
      goed(`Thermostaat "${d.name}" (${app}): ${waarden}.`);
    }
  }

  // 3. Losse temperatuursensoren, voor kamer= in het argument
  const sensoren = apparaten
    .filter((d) => d.capabilitiesObj?.measure_temperature && !d.capabilitiesObj?.target_temperature)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const kamersensor = KAMERSENSOR.trim();
  if (sensoren.length) {
    regels.push("");
    regels.push("Temperatuursensoren (voor kamer= in het argument):");
    for (const d of sensoren) regels.push(`      "${d.name}": ${d.capabilitiesObj.measure_temperature?.value ?? "onbekend"} °C`);
    regels.push("");
  }
  let kamerOk = false;
  if (kamersensor) {
    const d = apparaten.find((x) => x.name === kamersensor);
    const t = d?.capabilitiesObj?.measure_temperature?.value;
    if (!d) fout(`Kamersensor "${kamersensor}" niet gevonden. Neem de naam precies over uit de lijst hierboven.`);
    else if (typeof t !== "number") fout(`Kamersensor "${kamersensor}" geeft (nog) geen temperatuur.`);
    else { goed(`Kamersensor "${kamersensor}": ${t} °C.`); kamerOk = true; }
    if (!kamerOk) alles = false;
  }

  // 4. Bewaren tussen twee runs
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

  // 5. De regel voor de flow
  const naam = thermostaten.length === 1 ? thermostaten[0].name : "naam van je thermostaat";
  regels.push("");
  regels.push(alles ? "Alles in orde. Zet dit als argument in de flow:" : "Los eerst de FOUT-regels op. Daarna wordt het argument:");
  regels.push(`<je sleutel>;${naam}${kamerOk ? `;kamer=${kamersensor}` : ""}`);
  regels.push("(Je sleutel staat hier bewust niet in, zodat je deze tekst veilig kunt delen.)");
  if (thermostaten.length > 1) regels.push("(Kies de naam van de thermostaat die je pomp aanstuurt, precies zoals hierboven.)");
  if (!kamersensor && sensoren.length) regels.push("(Meet een sensor hierboven de kamer beter? Zet zijn naam bovenin bij KAMERSENSOR en druk opnieuw op Test.)");
  return regels.join("\n");
}

return await controle();
