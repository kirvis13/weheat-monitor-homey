# Changelog

Versies volgen [Semantic Versioning](https://semver.org). De nieuwste versie staat bovenaan.

## 0.4.0 (9 november 2026)

- **Ruimtes.** Nieuwe optie `ruimtes=alle` of `ruimtes=Slaapkamer achter,Zolder`: de temperatuursensoren in die zones gaan elk als ruimte naar weheat-monitor.nl, met de zone als naam en de zone erboven als verdieping. Vocht, CO2 en luchtdruk van hetzelfde apparaat, of van de enige in dezelfde zone, gaan mee. Nooit een thermostaat of radiatorkraan, nooit buiten, hooguit 20.
- Alleen nieuwe waarden, op het tijdstip dat de sensor veranderde; nooit een herhaling. Ruimtemetingen hebben een eigen wachtrij (24 uur, 3.000 metingen); een site die ruimtes nog niet kent, laat ze wachten in plaats van ze kwijt te raken.
- Een ruimtesensor die twee uur geen nieuwe temperatuur geeft, staat één keer in de tijdlijn.
- `controle.js` heeft bovenin `RUIMTES`, noemt alle temperatuursensoren per zone en laat zien wat er per ruimte meegaat.

## 0.3.0 (19 oktober 2026)

- Het script meldt zich in de tijdlijn van Homey, alleen als er iets verandert: de eerste keer verbonden, een storing van een kwartier (een geweigerde sleutel meteen), weer verbonden na zo'n storing, en een thermostaat of kamersensor die niet gevonden wordt. Zo zie je na het testen van de flow dat het werkt.
- Een kamersensor uit `kamer=` die niet gevonden wordt of geen temperatuur geeft, staat nu ook in de tijdlijn in plaats van in de testtekst, die bij een flow niet te zien is.
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
