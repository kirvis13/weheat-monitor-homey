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
    .replace(SLOT, "return { hoofd, handmatigVerzet, kiesBlok, leesInstellingen };");
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
const Homey = {
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
const zoek = await (await laad()({ devices: { getDevices: async () => ({}) } }, fetchNep, glob, log)).hoofd();
check("verkeerde naam: de terugmelding zegt welke naam", true, zoek.includes('thermostaat "Woonkamer" niet gevonden'));
check("terugmelding begint met de versie", true, /^v\d+\.\d+\.\d+: /.test(zoek));

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
  { sleutel: "whm_x", thermostaat: "Toon", kamersensor: "", volg: false, tsetApparaat: "", tsetCapability: "" },
  api.leesInstellingen(" whm_x ; Toon "));
check("instellingen: alle opties, naam met spatie, hoofdletters in de optie",
  { sleutel: "whm_x", thermostaat: "Toon woonkamer", kamersensor: "Sensor hal", volg: true, tsetApparaat: "OT Gateway", tsetCapability: "target_temperature.boiler" },
  api.leesInstellingen("whm_x;Toon woonkamer;Volg;kamer=Sensor hal;tset=OT Gateway/target_temperature.boiler"));
check("instellingen: leeg argument", "", api.leesInstellingen(undefined).sleutel);

// ─── 7. Controlescript ──────────────────────────────────────────────────────
console.log("\n7. Controlescript (controle.js)");
const controleBron = lees("controle.js");
check("controle eindigt met de aanroep van controle()", true, controleBron.trimEnd().endsWith("return await controle();"));
type Keuzes = { thermostaat?: string; kamer?: string; volg?: boolean };
async function controle(sleutel: string, apparaten: Record<string, unknown>, fe: unknown, k: Keuzes = {}, g: unknown = glob) {
  const code = controleBron.replace('const SLEUTEL = "whm_...";', `const SLEUTEL = ${JSON.stringify(sleutel)};`)
    .replace('const THERMOSTAAT = "";', `const THERMOSTAAT = ${JSON.stringify(k.thermostaat ?? "")};`)
    .replace('const KAMERSENSOR = "";', `const KAMERSENSOR = ${JSON.stringify(k.kamer ?? "")};`)
    .replace("const VOLG_PLAN = false;", `const VOLG_PLAN = ${k.volg ?? false};`)
    .replace("const TIMEOUT_MS = 10_000;", "const TIMEOUT_MS = 200;");
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const f = new AsyncFunction("Homey", "fetch", "global", "AbortController", code);
  return f({ devices: { getDevices: async () => apparaten } }, fe, g, undefined) as Promise<string>;
}
const argumentRegel = (uit: string) => /^ {2}Argument {2}(.*)$/m.exec(uit)?.[1] ?? null;
for (const naam of ["THERMOSTAAT", "KAMERSENSOR", "VOLG_PLAN"]) {
  check(`controle heeft ${naam} bovenin`, true, new RegExp(`^const ${naam} = `, "m").test(controleBron));
}
antwoord = { status: 200, data: { plan_live: false, base_setpoint: 20, blocks: [] } };
const voorControle = verzonden.length;
const goedUit = await controle(SLEUTEL, { t1: thermostaat }, fetchNep);
check("één thermostaat, niets ingevuld: flowblok met kant-en-klaar argument", [true, `${SLEUTEL};Woonkamer`, true],
  [goedUit.includes("Alles in orde"), argumentRegel(goedUit), goedUit.includes("Voer een script uit met argument")]);
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

Date.now = echteNu;
console.log(fouten ? `\n${fouten} fout(en)` : "\nAlles groen");
process.exit(fouten ? 1 : 0);
