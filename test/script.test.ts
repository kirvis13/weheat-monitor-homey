/**
 * Het HomeyScript (weheat-monitor.js): meten, synchroniseren en sturen, met een
 * nagebootste Homey en server. Dezelfde regels als de Home Assistant-integratie
 * (kirvis13/weheat-monitor-ha): alleen sturen met plan_live én plan volgen,
 * 12-24 °C, afronden op de stap van de thermostaat, de mens wint vier uur, één
 * keer terug naar de basis, terugvallen na een fout. Het script draait zoals in
 * HomeyScript: zonder AbortController, met de instellingen in `args[0]`.
 *
 * Draai: bun run test/script.test.ts (vanuit de repo-root)
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

let fouten = 0;
function check(naam: string, verwacht: unknown, kreeg: unknown) {
  const ok = JSON.stringify(verwacht) === JSON.stringify(kreeg);
  if (!ok) fouten++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${naam}${ok ? "" : `\n      verwacht ${JSON.stringify(verwacht)}\n      kreeg    ${JSON.stringify(kreeg)}`}`);
}
const lees = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const SLEUTEL = "whm_" + "a".repeat(64);
const bron = lees("weheat-monitor.js");
const SLOT = "return await hoofd();";
check("script eindigt met de aanroep van hoofd()", true, bron.trimEnd().endsWith(SLOT));

/** Het script als functie, met nagebootste Homey, fetch, global en log. */
function laad(opties: { volg?: boolean; argument?: string | null; zonderKlok?: boolean } = {}) {
  const code = bron
    .replace("const TIMEOUT_MS = 10_000;", "const TIMEOUT_MS = 200;")
    .replace(SLOT, "return { hoofd, handmatigVerzet, kiesBlok, leesInstellingen, meldingen, sha256Hex, kiesRuimtes, metgezellen, ruimtesVoorAanroep };");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  // Zoals in HomeyScript: geen AbortController. Met zonderKlok ook geen setTimeout.
  const f = new AsyncFunction("Homey", "fetch", "global", "log", "args", "AbortController", "setTimeout", "clearTimeout", code);
  const klok = opties.zonderKlok ? [undefined, undefined] : [setTimeout, clearTimeout];
  const argument = opties.argument !== undefined ? opties.argument : `${SLEUTEL};Woonkamer${(opties.volg ?? true) ? ";volg" : ""}`;
  const args = argument === null ? undefined : [argument];
  return (H: unknown, fe: unknown, g: unknown, l: unknown) => f(H, fe, g, l, args, undefined, ...klok);
}

// ─── Nagebootste wereld ─────────────────────────────────────────────────────

const MIN = 60_000;
let nu = Date.parse("2026-10-16T10:00:20Z");
const echteNu = Date.now;
Date.now = () => nu;

const thermostaat = {
  id: "t1", name: "Woonkamer", driverId: "homey:app:com.tado2:thermostat",
  capabilitiesObj: {
    measure_temperature: { value: 20.1 },
    target_temperature: { value: 20, min: 5, max: 25, step: 0.5 },
    thermostat_mode: { values: [{ id: "heat" }, { id: "off" }] },
  },
};
const geschreven: number[] = [];
const tijdlijn: string[] = [];
const Homey = {
  flow: { runFlowCardAction: async ({ id, args }: { id: string; args: { text: string } }) => {
    if (id !== "homey:manager:notifications:create_notification") throw new Error("onbekende kaart");
    tijdlijn.push(args.text);
  } },
  devices: {
    getDevices: async () => ({ t1: thermostaat }),
    setCapabilityValue: async ({ value }: { value: number }) => { geschreven.push(value); },
  },
};
const opslag = new Map<string, string>();
const glob = { get: (k: string) => opslag.get(k), set: (k: string, v: string) => opslag.set(k, v) };

let antwoord: { status: number; data: unknown } = { status: 200, data: { stored: 1, plan_live: false, base_setpoint: 20, blocks: [] } };
const verzonden: { auth: string; body: Record<string, any> }[] = [];
const fetchNep = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
  verzonden.push({ auth: init.headers.Authorization, body: JSON.parse(init.body) });
  return { status: antwoord.status, json: async () => antwoord.data };
};
const logs: string[] = [];
const log = (x: string) => logs.push(x);

async function run(opties: { volg?: boolean } = {}) {
  const f = laad(opties);
  const api = await f(Homey, fetchNep, glob, log);
  return api.hoofd();
}
const toestand = () => JSON.parse(opslag.get("weheat_monitor_toestand") ?? "{}");
const blok = (setpoint: number, van: number, tot: number, plan_id: number, gemaakt = van) =>
  ({ plan_id, setpoint, start: new Date(van).toISOString(), end: new Date(tot).toISOString(), created_at: new Date(gemaakt).toISOString() });

// ─── 1. Opzet en eerste meting ──────────────────────────────────────────────
console.log("\n1. Sleutel en eerste meting");
let fout = "";
try { await (await laad({ argument: "whm_...;Woonkamer" })(Homey, fetchNep, glob, log)).hoofd(); } catch (e) { fout = String(e); }
check("ongeldige sleutel: duidelijke fout, niets verstuurd", [true, 0], [fout.includes("sleutel"), verzonden.length]);
fout = "";
try { await (await laad({ argument: null })(Homey, fetchNep, glob, log)).hoofd(); } catch (e) { fout = String(e); }
check("zonder argument (gestart zonder flow): fout wijst naar de flowkaart", [true, 0], [fout.includes("met argument"), verzonden.length]);

await run({ volg: false });
const eerste = verzonden[0];
check("sleutel alleen in de Authorization-kop", [`Bearer ${SLEUTEL}`, false], [eerste.auth, JSON.stringify(eerste.body).includes(SLEUTEL)]);
check("meting: hele minuut, bron homey, kamer en setpoint",
  { measured_at: "2026-10-16T10:00:00Z", source: "homey", room_temp: 20.1, setpoint: 20 }, eerste.body.measurements[0]);
check("thermostaat: app, driver, stap, grenzen, modi; geen naam of id",
  { integration: "homey_com_tado2", model: "thermostat", target_temp_step: 0.5, min_temp: 5, max_temp: 25, hvac_modes: ["heat", "off"] },
  eerste.body.thermostat);
check("wachtrij leeg na een geslaagde sync", 0, toestand().wachtrij.length);

nu += MIN;
await run({ volg: false });
check("thermostaat niet elke minuut opnieuw gemeld", false, "thermostat" in verzonden[1].body);

// ─── 2. Sturen ──────────────────────────────────────────────────────────────
console.log("\n2. Sturen");
antwoord = { status: 200, data: { plan_live: true, base_setpoint: 20, blocks: [blok(21.3, nu - MIN, nu + 60 * MIN, 7)] } };
nu += MIN;
await run({ volg: false });
check("plan volgen uit: niets geschreven", [], geschreven);

nu += MIN;
await run();
check("plan_live en volgen: blok afgerond op de stap van 0,5", [21.5], geschreven);
thermostaat.capabilitiesObj.target_temperature.value = 21.5;
nu += MIN;
await run();
check("plan_id één keer als toegepast gemeld", [7], verzonden.at(-1)!.body.applied);
check("niet opnieuw schrijven als het al staat", [21.5], geschreven);
nu += MIN;
await run();
check("toegepast niet nog eens", false, "applied" in verzonden.at(-1)!.body);

antwoord = { status: 200, data: { plan_live: true, base_setpoint: 20, blocks: [blok(30, nu - MIN, nu + 60 * MIN, 8)] } };
nu += MIN; await run(); nu += MIN; await run();
check("nooit boven 24 °C, ook als de thermostaat 25 aankan", 24, geschreven.at(-1));
thermostaat.capabilitiesObj.target_temperature.value = 24;

antwoord = { status: 200, data: { plan_live: true, base_setpoint: 20, blocks: [
  blok(19, nu - 10 * MIN, nu + 60 * MIN, 9, nu - 10 * MIN), blok(22, nu - 5 * MIN, nu + 60 * MIN, 10, nu - 5 * MIN)] } };
nu += MIN; await run(); nu += MIN; await run();
check("overlappende blokken: het nieuwste wint", 22, geschreven.at(-1));

// ─── 3. Cloudvertraging en handmatig verzet ─────────────────────────────────
console.log("\n3. De mens wint");
const voor = geschreven.length;
nu += MIN; await run();
check("thermostaat meldt na het schrijven nog de oude waarde: geen handmatig verzet",
  [null, true], [toestand().sturing.pauze_tot, geschreven.length > voor]);
thermostaat.capabilitiesObj.target_temperature.value = 22;
nu += MIN; await run();

thermostaat.capabilitiesObj.target_temperature.value = 18.5;
nu += MIN;
const n = geschreven.length;
await run();
check("iemand zet 18,5: vier uur pauze, meting gemarkeerd, niets geschreven",
  [true, true, n], [toestand().sturing.pauze_tot !== null, verzonden.at(-1)!.body.measurements.at(-1).manual, geschreven.length]);
nu += 3 * 3600_000; await run();
check("na drie uur nog steeds niet", n, geschreven.length);
check("alleen de eerste meting is gemarkeerd", undefined, verzonden.at(-1)!.body.measurements.at(-1).manual);
antwoord = { status: 200, data: { plan_live: true, base_setpoint: 20, blocks: [blok(21, nu, nu + 4 * 3600_000, 11)] } };
nu += 3600_000 + MIN; await run();
check("na vier uur weer sturen", 21, geschreven.at(-1));
thermostaat.capabilitiesObj.target_temperature.value = 21;

// ─── 4. Einde plan ──────────────────────────────────────────────────────────
console.log("\n4. Geen plan meer");
antwoord = { status: 200, data: { plan_live: true, base_setpoint: 19.5, blocks: [] } };
nu += MIN; await run(); nu += MIN; await run();
check("één keer terug naar de basis", 19.5, geschreven.at(-1));
thermostaat.capabilitiesObj.target_temperature.value = 19.5;
const m = geschreven.length;
nu += MIN; await run(); nu += MIN; await run();
check("daarna met rust gelaten", m, geschreven.length);

// ─── 5. Fouten ──────────────────────────────────────────────────────────────
console.log("\n5. Fouten en wachtrij");
antwoord = { status: 503, data: null };
nu += MIN; await run();
const posts = verzonden.length;
nu += 30_000; await run();
check("na een 503: binnen de minuut geen nieuwe aanroep; meting bewaard, één per minuut", [posts, 1], [verzonden.length, toestand().wachtrij.length]);
nu += 2 * MIN; await run();
check("tweede 503: wachttijd verdubbelt naar 2 minuten", 2, toestand().fouten);
antwoord = { status: 200, data: { plan_live: true, base_setpoint: 19.5, blocks: [] } };
nu += 5 * MIN; await run();
check("daarna gaan de drie bewaarde minuten in één keer mee", [0, 3], [toestand().wachtrij.length, verzonden.at(-1)!.body.measurements.length]);

antwoord = { status: 401, data: { error: "unknown key" } };
nu += MIN;
fout = "";
try { await run(); } catch (e) { fout = String(e); }
check("401: fout zichtbaar in de flow, toestand bewaard", [true, 1], [fout.includes("weigert"), toestand().wachtrij.length]);

console.log("\n5b. Tijdslimiet");
const fetchHangt = () => new Promise(() => {});
const begin = echteNu();
const hangend = await (await laad()(Homey, fetchHangt, glob, log)).hoofd();
check("server antwoordt niet: na de tijdslimiet door, als fout geteld", [true, true],
  [hangend.includes("geen verbinding"), echteNu() - begin < 2_000]);
opslag.delete("weheat_monitor_toestand");
antwoord = { status: 200, data: { plan_live: false, base_setpoint: 20, blocks: [] } };
const zonder = await (await laad({ zonderKlok: true })(Homey, fetchNep, glob, log)).hoofd();
check("ook zonder setTimeout loopt het script", [true, 0], [typeof zonder === "string", toestand().wachtrij.length]);

console.log("\n5c. Thermostaat niet gevonden");
const zonderThermostaat = { flow: Homey.flow, devices: { getDevices: async () => ({}) } };
const voorZoek = tijdlijn.length;
let zoek = "";
try { await (await laad()(zonderThermostaat, fetchNep, glob, log)).hoofd(); } catch (e) { zoek = String(e); }
check("verkeerde naam: de flowkaart wordt rood en zegt welke naam", true, zoek.includes('thermostaat "Woonkamer" niet gevonden'));
nu += MIN;
try { await (await laad()(zonderThermostaat, fetchNep, glob, log)).hoofd(); } catch { /* nog steeds fout */ }
check("verkeerde naam: één keer in de tijdlijn, niet elke minuut", 1,
  tijdlijn.slice(voorZoek).filter((t) => t.includes('"Woonkamer" niet gevonden')).length);
nu += MIN;
const terug = await run();
check("terugmelding begint met de versie", true, /^v\d+\.\d+\.\d+: /.test(terug));

console.log("\n5d. Thermostaat nog niet klaar (vlak na een herstart van Homey)");
opslag.delete("weheat_monitor_toestand");
const leeg = { ...thermostaat, capabilitiesObj: { measure_temperature: { value: null }, target_temperature: { value: null } } };
const voorLeeg = verzonden.length;
await (await laad()({ devices: { getDevices: async () => ({ t1: leeg }), setCapabilityValue: async () => {} } }, fetchNep, glob, log)).hoofd();
check("geen enkele waarde: geen meting in de wachtrij of in de aanroep", [0, undefined],
  [toestand().wachtrij.length, verzonden.slice(voorLeeg).flatMap((v) => v.body.measurements ?? []).at(0)]);

// ─── 6. Regels los ──────────────────────────────────────────────────────────
console.log("\n6. Regels");
const api = await laad()(Homey, fetchNep, glob, log);
check("eerste run zonder geschiedenis is geen handmatig verzet", false, api.handmatigVerzet(null, 20, null));
check("na een herstart: anders dan wat we schreven is handmatig", true, api.handmatigVerzet(null, 18, 21));
check("blok zonder setpoint telt niet", null, api.kiesBlok([{ start: "2026-01-01T00:00:00Z", end: "2030-01-01T00:00:00Z" }], nu));
check("instellingen: alleen sleutel en thermostaat",
  { sleutel: "whm_x", thermostaat: "Toon", kamersensor: "", volg: false, tsetApparaat: "", tsetCapability: "", ruimtes: null },
  api.leesInstellingen(" whm_x ; Toon "));
check("instellingen: alle opties, naam met spatie, hoofdletters in de optie",
  { sleutel: "whm_x", thermostaat: "Toon woonkamer", kamersensor: "Sensor hal", volg: true, tsetApparaat: "OT Gateway", tsetCapability: "target_temperature.boiler", ruimtes: null },
  api.leesInstellingen("whm_x;Toon woonkamer;Volg;kamer=Sensor hal;tset=OT Gateway/target_temperature.boiler"));
check("instellingen: leeg argument", "", api.leesInstellingen(undefined).sleutel);
check("instellingen: ruimtes=alle, ruimtes=lijst, ruimtes= leeg", ["alle", ["Slaapkamer achter", "Zolder"], null],
  ["whm_x;Toon;ruimtes=Alle", "whm_x;Toon;ruimtes= Slaapkamer achter , Zolder", "whm_x;Toon;ruimtes="].map((a) => api.leesInstellingen(a).ruimtes));

// ─── 7. Controlescript ──────────────────────────────────────────────────────
console.log("\n7. Controlescript (controle.js)");
const controleBron = lees("controle.js");
check("controle eindigt met de aanroep van controle()", true, controleBron.trimEnd().endsWith("return await controle();"));
type Keuzes = { thermostaat?: string; kamer?: string; volg?: boolean; ruimtes?: string; zones?: Record<string, unknown> };
let controleTerug = "";
/** Draait controle.js en geeft wat het logt; wat het teruggeeft staat in controleTerug. */
async function controle(sleutel: string, apparaten: Record<string, unknown>, fe: unknown, k: Keuzes = {}, g: unknown = glob) {
  const code = controleBron.replace('const SLEUTEL = "whm_...";', `const SLEUTEL = ${JSON.stringify(sleutel)};`)
    .replace('const THERMOSTAAT = "";', `const THERMOSTAAT = ${JSON.stringify(k.thermostaat ?? "")};`)
    .replace('const KAMERSENSOR = "";', `const KAMERSENSOR = ${JSON.stringify(k.kamer ?? "")};`)
    .replace("const VOLG_PLAN = false;", `const VOLG_PLAN = ${k.volg ?? false};`)
    .replace('const RUIMTES = "";', `const RUIMTES = ${JSON.stringify(k.ruimtes ?? "")};`)
    .replace("const TIMEOUT_MS = 10_000;", "const TIMEOUT_MS = 200;");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const f = new AsyncFunction("Homey", "fetch", "global", "AbortController", "log", code);
  const gelogd: string[] = [];
  controleTerug = await f({ flow: Homey.flow, devices: { getDevices: async () => apparaten }, zones: { getZones: async () => k.zones ?? {} } },
    fe, g, undefined, (x: string) => gelogd.push(x));
  return gelogd.join("\n");
}
const argumentRegel = (uit: string) => /Argument: kopieer de regel hieronder\n\n(.*)$/m.exec(uit)?.[1] ?? null;
for (const naam of ["THERMOSTAAT", "KAMERSENSOR", "VOLG_PLAN", "RUIMTES"]) {
  check(`controle heeft ${naam} bovenin`, true, new RegExp(`^const ${naam} = `, "m").test(controleBron));
}
antwoord = { status: 200, data: { plan_live: false, base_setpoint: 20, blocks: [] } };
const voorControle = verzonden.length;
const goedUit = await controle(SLEUTEL, { t1: thermostaat }, fetchNep);
check("één thermostaat, niets ingevuld: flowblok met kant-en-klaar argument", [true, `${SLEUTEL};Woonkamer`, true],
  [goedUit.includes("Alles in orde"), argumentRegel(goedUit), goedUit.includes("Voer een script uit met argument")]);
check("controle zet een regel in de tijdlijn en meldt dat", [true, true],
  [tijdlijn.at(-1)?.includes("controle gedaan"), goedUit.includes("kan in de tijdlijn schrijven")]);
check("controle stuurt geen metingen", [], verzonden.slice(voorControle).flatMap((v) => v.body.measurements ?? []));
check("sleutel alleen in de argumentregel", 1, goedUit.split(SLEUTEL).length - 1);
check("controle laat niets achter in de opslag", undefined, opslag.get("weheat_monitor_controle") ?? undefined);
antwoord = { status: 401, data: { error: "unknown key" } };
const geweigerd = await controle(SLEUTEL, { t1: thermostaat }, fetchNep);
check("401: sleutel geweigerd, geen flowblok", [true, null], [geweigerd.includes("Sleutel geweigerd"), argumentRegel(geweigerd)]);
const voorLeegSleutel = verzonden.length;
const leegSleutel = await controle("whm_...", { t1: thermostaat }, fetchNep);
check("niet ingevuld: vraagt om de sleutel, roept de site niet aan, geen flowblok", [true, voorLeegSleutel, null],
  [leegSleutel.includes("vul bovenin je sleutel in"), verzonden.length, argumentRegel(leegSleutel)]);
antwoord = { status: 200, data: { plan_live: true, base_setpoint: 20, blocks: [] } };
const geenThermostaat = await controle(SLEUTEL, { l1: { name: "Lamp", capabilitiesObj: { onoff: { value: true } } } }, fetchNep);
check("geen thermostaat: FOUT-regel", true, geenThermostaat.includes("Geen thermostaat gevonden"));
const werkkamer = { ...thermostaat, id: "t2", name: "Werkkamer" };
const twee = await controle(SLEUTEL, { t1: thermostaat, t2: werkkamer }, fetchNep);
check("twee thermostaten, niets ingevuld: beide genoemd, vraagt om THERMOSTAAT, geen gok", [true, true, true, null],
  [twee.includes('"Woonkamer"'), twee.includes('"Werkkamer"'), twee.includes("Zet bij THERMOSTAAT"), argumentRegel(twee)]);
check("plan aan wordt gemeld", true, twee.includes("Plan voor deze koppeling: aan"));
const gekozenT = await controle(SLEUTEL, { t1: thermostaat, t2: werkkamer }, fetchNep, { thermostaat: "Werkkamer" });
check("THERMOSTAAT gekozen: die in het argument", `${SLEUTEL};Werkkamer`, argumentRegel(gekozenT));
const tikT = await controle(SLEUTEL, { t1: thermostaat }, fetchNep, { thermostaat: "woonkamer" });
check("THERMOSTAAT met tikfout: FOUT, geen flowblok", [true, null], [tikT.includes('Thermostaat "woonkamer" niet gevonden'), argumentRegel(tikT)]);

const hal = { id: "s1", name: "Sensor hal", capabilitiesObj: { measure_temperature: { value: 19.4 } } };
const geenThermo = await controle(SLEUTEL, { t1: thermostaat, s1: hal }, fetchNep, { thermostaat: "Sensor hal" });
check("een thermometer als THERMOSTAAT: FOUT", true, geenThermo.includes('"Sensor hal" heeft geen ingestelde temperatuur'));
const metSensor = await controle(SLEUTEL, { t1: thermostaat, s1: hal }, fetchNep);
check("thermometer in de lijst, geen kamer= zonder keuze", [true, `${SLEUTEL};Woonkamer`],
  [metSensor.includes('"Sensor hal": 19.4'), argumentRegel(metSensor)]);
const alles = await controle(SLEUTEL, { t1: thermostaat, s1: hal }, fetchNep, { thermostaat: "Woonkamer", kamer: "Sensor hal", volg: true });
check("alles ingevuld: volg en kamer= in het argument", `${SLEUTEL};Woonkamer;volg;kamer=Sensor hal`, argumentRegel(alles));
check("het argument werkt in het script", { sleutel: SLEUTEL, thermostaat: "Woonkamer", volg: true, kamersensor: "Sensor hal" },
  (({ sleutel, thermostaat: t, volg, kamersensor }) => ({ sleutel, thermostaat: t, volg, kamersensor }))(
    (await laad()(Homey, fetchNep, glob, log)).leesInstellingen(argumentRegel(alles))));
const tikfout = await controle(SLEUTEL, { t1: thermostaat, s1: hal }, fetchNep, { kamer: "sensor hal" });
check("teruggegeven tekst is één korte regel, zonder sleutel", [false, false],
  [controleTerug.includes("\n"), controleTerug.includes(SLEUTEL)]);
const itho = { name: "Itho", capabilitiesObj: { measure_temperature: { value: 16.6 } } };
const dubbel = await controle(SLEUTEL, { t1: thermostaat, i1: itho, i2: { ...itho } }, fetchNep, { kamer: "Itho" });
check("dubbele naam: gemarkeerd in de lijst, als keuze een FOUT", [true, true, null],
  [dubbel.includes("naam staat dubbel"), dubbel.includes('De naam "Itho" staat 2 keer'), argumentRegel(dubbel)]);
check("kamersensor met tikfout: FOUT, geen flowblok", [true, null], [tikfout.includes('Kamersensor "sensor hal" niet gevonden'), argumentRegel(tikfout)]);

// Het script zelf met kamer=
const HomeyMetSensor = { devices: { ...Homey.devices, getDevices: async () => ({ t1: thermostaat, s1: hal }) } };
const metKamer = (naam: string) => laad({ argument: `${SLEUTEL};Woonkamer;kamer=${naam}` })(HomeyMetSensor, fetchNep, glob, log).then((a: any) => a.hoofd());
antwoord = { status: 200, data: { stored: 1, plan_live: false, base_setpoint: 20, blocks: [] } };
nu += MIN;
const tekstGoed = await metKamer("Sensor hal");
check("kamer=: kamertemperatuur uit de sensor, geen waarschuwing", [19.4, false],
  [verzonden.at(-1)!.body.measurements.at(-1).room_temp, tekstGoed.includes("kamersensor")]);
nu += MIN;
const tekstWeg = await metKamer("Sensor zolder");
check("kamer= niet gevonden: kamer van de thermostaat, en de testtekst zegt het", [20.1, true],
  [verzonden.at(-1)!.body.measurements.at(-1).room_temp, tekstWeg.includes('kamersensor "Sensor zolder" niet gevonden')]);

// ─── 8. Tijdlijn ────────────────────────────────────────────────────────────
console.log("\n8. Meldingen in de Homey-tijdlijn");
{
  const api = await laad()(Homey, fetchNep, glob, log);
  const m: Record<string, unknown> = {};
  const t0 = Date.parse("2026-10-19T08:00:00Z");
  const ok = { verbonden: true, fout: null, probleem: "", kamer: 18.6, setpoint: 17 };
  const eerst = api.meldingen(m, t0, ok);
  check("eerste keer verbonden: één melding met kamer en setpoint", [1, true], [eerst.length, eerst[0]?.includes("verbonden") && eerst[0]?.includes("kamer 18.6 °C")]);
  check("daarna stil", [], api.meldingen(m, t0 + MIN, ok));
  const storing = { ...ok, fout: "geen verbinding" };
  check("storing: eerst een kwartier stil", [[], []], [api.meldingen(m, t0 + 2 * MIN, storing), api.meldingen(m, t0 + 16 * MIN, storing)]);
  const na = api.meldingen(m, t0 + 17 * MIN, storing);
  check("storing van een kwartier: één melding met het begin (NL-tijd)", [1, true], [na.length, na[0]?.includes("sinds 10:02")]);
  check("en niet nog eens", [], api.meldingen(m, t0 + 30 * MIN, storing));
  const herstel = api.meldingen(m, t0 + 31 * MIN, ok);
  check("hersteld na een melding: 'weer verbonden'", [1, true], [herstel.length, herstel[0]?.includes("weer verbonden")]);
  api.meldingen(m, t0 + 32 * MIN, storing);
  check("korte storing zonder melding: ook geen herstelmelding", [], api.meldingen(m, t0 + 35 * MIN, ok));
  const sleutel = api.meldingen(m, t0 + 36 * MIN, { ...ok, fout: "sleutel geweigerd" });
  check("geweigerde sleutel: meteen", [1, true], [sleutel.length, sleutel[0]?.includes("weigert de sleutel")]);
  const m2: Record<string, unknown> = { verbonden: true };
  const p1 = api.meldingen(m2, t0, { ...ok, probleem: 'kamersensor "Hal" niet gevonden' });
  check("instelling klopt niet: één melding, daarna stil, na herstel weer klaar", [1, [], []],
    [p1.length, api.meldingen(m2, t0 + MIN, { ...ok, probleem: 'kamersensor "Hal" niet gevonden' }), api.meldingen(m2, t0 + 2 * MIN, ok)]);

  // Het hele script: de eerste geslaagde run zet een regel in de tijdlijn
  opslag.delete("weheat_monitor_toestand");
  antwoord = { status: 200, data: { stored: 1, plan_live: false, base_setpoint: 20, blocks: [] } };
  const voor = tijdlijn.length;
  nu += MIN; await run();
  nu += MIN; await run();
  check("script: eerste run in de tijdlijn, de tweede niet", [1, true],
    [tijdlijn.length - voor, tijdlijn.at(-1)?.startsWith("✅ Weheat Monitor: verbonden")]);
  check("de sleutel komt nooit in de tijdlijn", false, tijdlijn.some((t) => t.includes(SLEUTEL)));
  const zonderTijdlijn = { devices: Homey.devices, flow: { runFlowCardAction: async () => { throw new Error("geen toegang"); } } };
  opslag.delete("weheat_monitor_toestand");
  nu += MIN;
  const tekst = await (await laad()(zonderTijdlijn, fetchNep, glob, log)).hoofd();
  check("tijdlijn faalt: script loopt gewoon door", true, tekst.startsWith("v"));
}


// ─── 9. Ruimtes ─────────────────────────────────────────────────────────────
console.log("\n9. Ruimtes (ruimtes=)");
{
  const blokVan = (t: string) => t.slice(t.indexOf("// ─── Ruimtes kiezen:"), t.indexOf("// ─── einde ruimtes kiezen ───"));
  check("ruimtes kiezen: blok in weheat-monitor.js en controle.js gelijk", true,
    blokVan(bron).length > 500 && blokVan(bron) === blokVan(lees("controle.js")));
  const api = await laad()(Homey, fetchNep, glob, log);
  const teksten = ["", "abc", "device-1f0e2d3c", "Zolder ° €", "x".repeat(55), "y".repeat(56), "z".repeat(64), "w".repeat(130)];
  check("sha256 zonder imports gelijk aan die van Node", teksten.map((t) => createHash("sha256").update(t).digest("hex")),
    teksten.map((t) => api.sha256Hex(t)));

  const zones = {
    huis: { id: "huis", name: "Thuis", parent: null },
    bg: { id: "bg", name: "Begane grond", parent: "huis" },
    v1: { id: "v1", name: "Eerste verdieping", parent: "huis" },
    woon: { id: "woon", name: "Woonkamer", parent: "bg" },
    keuken: { id: "keuken", name: "Keuken", parent: "bg" },
    slaap: { id: "slaap", name: "Slaapkamer achter", parent: "v1" },
    zolder: { id: "zolder", name: "Zolder", parent: "huis" },
    tuin: { id: "tuin", name: "Tuin", parent: "huis" },
  };
  const LU = "2026-11-09T07:41:12.345Z";
  const cap = (value: number, lastUpdated: string | undefined = LU) => ({ value, lastUpdated });
  const ruimteApparaten: Record<string, any> = {
    t1: { ...thermostaat, zone: "woon" },
    aqara: { id: "aqara", name: "Aqara slaap", zone: "slaap", capabilitiesObj: { measure_temperature: cap(17.2), measure_humidity: cap(63), measure_battery: cap(80) } },
    co2: { id: "co2", name: "CO2-meter", zone: "slaap", capabilitiesObj: { measure_co2: cap(640, "2026-11-09T07:44:58.000Z") } },
    keuken: { id: "keuken", name: "Keuken temperatuur", zone: "keuken", capabilitiesObj: { measure_temperature: cap(20.9), measure_pressure: cap(1013.2) } },
    vocht1: { id: "vocht1", name: "Vocht 1", zone: "keuken", capabilitiesObj: { measure_humidity: cap(55) } },
    vocht2: { id: "vocht2", name: "Vocht 2", zone: "keuken", capabilitiesObj: { measure_humidity: cap(58) } },
    tuin: { id: "tuin", name: "Weerstation", zone: "tuin", capabilitiesObj: { measure_temperature: cap(6.1) } },
    buitenwoon: { id: "buitenwoon", name: "Buitensensor", zone: "woon", capabilitiesObj: { measure_temperature: cap(6.3) } },
    zolder: { id: "zolder", name: "Zolder sensor", zone: "zolder", capabilitiesObj: { measure_temperature: cap(15.0) } },
    kraan: { id: "kraan", name: "Radiatorkraan zolder", zone: "zolder", capabilitiesObj: { measure_temperature: cap(19), target_temperature: { value: 18 } } },
  };
  const lijst = Object.values(ruimteApparaten);
  const alle = api.kiesRuimtes(lijst, zones, "alle");
  check("alle: alleen temperatuursensoren, geen thermostaat of radiatorkraan, gesorteerd op zone",
    [["Keuken", "Begane grond"], ["Slaapkamer achter", "Eerste verdieping"], ["Zolder", null]],
    alle.ruimtes.map((r: any) => [r.naam, r.verdieping]));
  check("buiten gaat nooit mee: zone Tuin, en een buitensensor in de woonkamer", ["Buitensensor", "Weerstation"],
    alle.buiten.map((r: any) => r.apparaatNaam).sort());
  check("een verdieping als zone neemt de zones erin mee", ["Slaapkamer achter"],
    api.kiesRuimtes(lijst, zones, ["eerste  verdieping"]).ruimtes.map((r: any) => r.naam));
  const tik = api.kiesRuimtes(lijst, zones, ["Zolder", "Garage"]);
  check("onbekende zone gemeld, de rest gaat mee", [["Garage"], ["Zolder"]], [tik.onbekend, tik.ruimtes.map((r: any) => r.naam)]);
  check("zonder zones van Homey: naam van het apparaat zonder 'temperatuur'", ["Keuken"],
    api.kiesRuimtes([{ id: "k", name: "Keuken temperatuur", capabilitiesObj: { measure_temperature: cap(20) } }], {}, "alle").ruimtes.map((r: any) => r.naam));
  const veel = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, zone: "zolder", capabilitiesObj: { measure_temperature: cap(18) } }));
  const teVeel = api.kiesRuimtes(veel, zones, "alle");
  check("hooguit 20, de rest geteld", [20, 5], [teVeel.ruimtes.length, teVeel.teVeel]);
  const slaap = alle.ruimtes.find((r: any) => r.naam === "Slaapkamer achter");
  const keuken = alle.ruimtes.find((r: any) => r.naam === "Keuken");
  const ids = (g: Record<string, any>) => Object.fromEntries(Object.entries(g).map(([k, d]) => [k, d.id]));
  check("vocht van het apparaat zelf, CO2 van de enige meter in de zone", { humidity: "aqara", co2: "co2" }, ids(api.metgezellen(slaap, lijst)));
  check("twee vochtmeters in de zone: geen vocht; luchtdruk van het apparaat", { pressure: "keuken" }, ids(api.metgezellen(keuken, lijst)));

  // Het script zelf
  const HomeyRuimtes = { flow: Homey.flow, zones: { getZones: async () => zones },
    devices: { getDevices: async () => ruimteApparaten, setCapabilityValue: async () => {} } };
  const metRuimtes = (arg = ";ruimtes=alle") => laad({ argument: `${SLEUTEL};Woonkamer${arg}` })(HomeyRuimtes, fetchNep, glob, log).then((a: any) => a.hoofd());
  opslag.delete("weheat_monitor_toestand");
  const sleutelVan = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
  antwoord = { status: 200, data: { stored: 1, plan_live: false, base_setpoint: 20, blocks: [], rooms: { stored: 3, duplicates: 0, skipped: 0 } } };
  nu = Date.parse("2026-11-09T08:00:20Z");
  const eersteTekst = await metRuimtes();
  const rooms = verzonden.at(-1)!.body.rooms;
  check("rooms: key is sha256 van het apparaat-id, naam en verdieping van de zone",
    [[sleutelVan("keuken"), "Keuken", "Begane grond"], [sleutelVan("aqara"), "Slaapkamer achter", "Eerste verdieping"], [sleutelVan("zolder"), "Zolder", undefined]],
    rooms.map((r: any) => [r.key, r.name, r.floor]));
  check("meting met het tijdstip van de nieuwste waarde (ms), vocht en CO2 erbij",
    [{ measured_at: "2026-11-09T07:44:58.000Z", temp: 17.2, humidity: 63, co2: 640 }], rooms[1].readings);
  check("luchtdruk in hPa (Homey geeft mbar)", 1013.2, rooms[0].readings[0].pressure);
  check("geen naam, zone of id van een apparaat in de aanroep", false,
    /Aqara|Weerstation|"aqara"|"slaap"/.test(JSON.stringify(verzonden.at(-1)!.body)));
  check("wachtrij leeg; de testtekst noemt de ruimtes", [0, true], [toestand().ruimte_wachtrij.length, eersteTekst.includes("ruimtes 3 van 3 meten")]);

  nu += MIN;
  await metRuimtes();
  check("niets veranderd: elke sensor gaat mee (naam), zonder metingen", [3, 0],
    [verzonden.at(-1)!.body.rooms.length, verzonden.at(-1)!.body.rooms.flatMap((r: any) => r.readings).length]);
  ruimteApparaten.aqara.capabilitiesObj.measure_humidity = cap(65, "2026-11-09T08:00:30.000Z");
  nu += MIN;
  await metRuimtes();
  check("alleen het vocht veranderde: één nieuwe meting op dat tijdstip",
    [{ measured_at: "2026-11-09T08:00:30.000Z", temp: 17.2, humidity: 65, co2: 640 }], verzonden.at(-1)!.body.rooms[1].readings);

  antwoord = { status: 200, data: { stored: 1, plan_live: false, base_setpoint: 20, blocks: [] } };
  ruimteApparaten.zolder.capabilitiesObj.measure_temperature = cap(15.5, "2026-11-09T08:02:05.000Z");
  nu += MIN;
  const ouder = await metRuimtes();
  check("site zonder rooms: meting blijft wachten, en de testtekst zegt het", [1, true],
    [toestand().ruimte_wachtrij.length, ouder.includes("site kent ruimtes nog niet")]);
  antwoord = { status: 200, data: { stored: 1, plan_live: false, base_setpoint: 20, blocks: [], rooms: { stored: 1, duplicates: 0, skipped: 0 } } };
  nu += MIN;
  await metRuimtes();
  check("daarna gaat hij alsnog mee", [0, 1], [toestand().ruimte_wachtrij.length, verzonden.at(-1)!.body.rooms[2].readings.length]);

  const voorStil = tijdlijn.length;
  nu = Date.parse("2026-11-09T10:03:00Z");
  ruimteApparaten.keuken.capabilitiesObj.measure_temperature = cap(21, "2026-11-09T10:02:00.000Z");
  ruimteApparaten.aqara.capabilitiesObj.measure_temperature = cap(17.3, "2026-11-09T10:01:00.000Z");
  await metRuimtes();
  nu += MIN;
  await metRuimtes();
  const stil = tijdlijn.slice(voorStil);
  check("zolder twee uur stil: één melding in de tijdlijn, met naam en zone", [1, true],
    [stil.length, stil[0]?.includes('"Zolder sensor" (Zolder)')]);

  antwoord = { status: 503, data: null };
  ruimteApparaten.keuken.capabilitiesObj.measure_temperature = cap(21.2, "2026-11-09T10:04:30.000Z");
  nu += MIN;
  await metRuimtes();
  check("storing: de ruimtemeting wacht", 1, toestand().ruimte_wachtrij.length);
  antwoord = { status: 200, data: { stored: 1, plan_live: false, base_setpoint: 20, blocks: [], rooms: { stored: 0, duplicates: 0, skipped: 0 } } };
  nu += 20 * MIN;
  await metRuimtes("");
  check("ruimtes= weggehaald: geen rooms in de aanroep, wachtrij leeg", [false, 0],
    ["rooms" in verzonden.at(-1)!.body, toestand().ruimte_wachtrij.length]);

  opslag.delete("weheat_monitor_toestand");
  const zonderTijd: Record<string, any> = { t1: { ...thermostaat, zone: "woon" },
    h: { id: "h", name: "Hal", zone: "woon", capabilitiesObj: { measure_temperature: { value: 19 } } } };
  const HomeyZonderTijd = { ...HomeyRuimtes, devices: { ...HomeyRuimtes.devices, getDevices: async () => zonderTijd } };
  const tel = () => verzonden.at(-1)!.body.rooms[0].readings.length;
  const zt = () => laad({ argument: `${SLEUTEL};Woonkamer;ruimtes=alle` })(HomeyZonderTijd, fetchNep, glob, log).then((a: any) => a.hoofd());
  nu += MIN; await zt(); const a1 = tel();
  nu += MIN; await zt(); const a2 = tel();
  zonderTijd.h.capabilitiesObj.measure_temperature = { value: 19.5 };
  nu += MIN; await zt(); const a3 = tel();
  check("zonder lastUpdated: eerste waarde, dan niets, dan de nieuwe waarde", [1, 0, 1], [a1, a2, a3]);

  const meta = [{ key: "k1aaaaaaaaaaaaaa", naam: "A", verdieping: null }];
  const rij = Array.from({ length: 150 }, (_, i) => ({ key: "k1aaaaaaaaaaaaaa", measured_at: new Date(nu - (150 - i) * MIN).toISOString(), temp: 18 }));
  const [payload, genomen] = api.ruimtesVoorAanroep(meta, rij);
  check("ruimtesVoorAanroep: 100 van 150, oudste eerst, zonder key in de meting", [100, rij[0].measured_at, false],
    [genomen, payload[0].readings[0].measured_at, "key" in payload[0].readings[0]]);

  antwoord = { status: 200, data: { plan_live: false, base_setpoint: 20, blocks: [] } };
  const cAlle = await controle(SLEUTEL, ruimteApparaten, fetchNep, { thermostaat: "Woonkamer", ruimtes: "alle", zones });
  check("controle: ruimtes=alle in het argument, overzicht per ruimte, buiten genoemd",
    [`${SLEUTEL};Woonkamer;ruimtes=alle`, true, true, true],
    [argumentRegel(cAlle), cAlle.includes("3 sensoren gaan mee"), /Slaapkamer achter \(Eerste verdieping\): 17\.3 °C, 65 %, 640 ppm/.test(cAlle),
      cAlle.includes('"Weerstation" buiten, gaat nooit mee')]);
  const cTik = await controle(SLEUTEL, ruimteApparaten, fetchNep, { ruimtes: "Zolder,Garage", zones });
  check("controle: onbekende zone is een FOUT, geen flowblok", [true, null], [cTik.includes('zone "Garage" niet gevonden'), argumentRegel(cTik)]);
  const cLeeg = await controle(SLEUTEL, ruimteApparaten, fetchNep, { thermostaat: "Woonkamer", zones });
  check("controle zonder RUIMTES: lijst per zone, niets in het argument", [true, `${SLEUTEL};Woonkamer`],
    [cLeeg.includes('"Keuken": "Keuken temperatuur" 21.2 °C, 1013.2 hPa'), argumentRegel(cLeeg)]);
}

Date.now = echteNu;
console.log(fouten ? `\n${fouten} fout(en)` : "\nAlles groen");
process.exit(fouten ? 1 : 0);
