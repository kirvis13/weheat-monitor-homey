# Changelog

Versies volgen [Semantic Versioning](https://semver.org). De nieuwste versie staat bovenaan.

## 0.3.0 (19 oktober 2026)

- Het script meldt zich in de tijdlijn van Homey, alleen als er iets verandert: de eerste keer verbonden, een storing van een kwartier (een geweigerde sleutel meteen), weer verbonden na zo'n storing, en een thermostaat of kamersensor die niet gevonden wordt. Zo zie je na het testen van de flow dat het werkt.
- Klopt de naam van de thermostaat niet, dan wordt de HomeyScript-kaart in de flow rood met de naam erbij, in plaats van stil door te lopen.
- `controle.js` controleert ook of HomeyScript in de tijdlijn kan schrijven.

## 0.2.1 (19 oktober 2026)

- `controle.js` heeft bovenin nu ook `THERMOSTAAT`, `KAMERSENSOR` en `VOLG_PLAN`, en noemt alle thermostaten en thermometers in Homey bij naam. Als alles klopt, eindigt het met precies wat je in de flow invult: de kaarten, het script en het argument, met je sleutel erin zodat je het in één keer kunt plakken. De uitvoer staat netjes onder elkaar (✅/❌ per controle) en waarschuwt voor namen die dubbel in Homey staan.
- Vindt het script de sensor uit `kamer=` niet, of geeft die geen temperatuur, dan staat dat in de testtekst. Het gebruikt dan de kamertemperatuur van de thermostaat, zoals al gebeurde.
- De installatiestappen in de README in de goede volgorde: eerst controleren, dan het script plakken, dan testen via de flow.

## 0.2.0 (16 oktober 2026)

- De instellingen staan nu in het argument van de flow (`whm_...;Toon;volg`), niet meer bovenin het script. Een update is daarmee: het hele script vervangen.
- Geen meting meer als de thermostaat nog geen enkele waarde geeft, bijvoorbeeld vlak na een herstart van Homey.
- De testtekst begint met de versie.
- Nieuw: `controle.js`, een los script dat vóór de installatie je sleutel, je thermostaten en de opslag van HomeyScript controleert en de regel voor de flow geeft.

## 0.1.0 (15 oktober 2026)

- Eerste versie: elke minuut kamertemperatuur en setpoint naar weheat-monitor.nl, en optioneel het plan volgen.
