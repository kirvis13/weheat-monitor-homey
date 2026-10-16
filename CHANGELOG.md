# Changelog

## 0.2.0 (16 oktober 2026)

- De instellingen staan nu in het argument van de flow (`whm_...;Toon;volg`), niet meer bovenin het script. Een update is daarmee: het hele script vervangen.
- Geen meting meer als de thermostaat nog geen enkele waarde geeft, bijvoorbeeld vlak na een herstart van Homey.
- De testtekst begint met de versie.
- Nieuw: `controle.js`, een los script dat vóór de installatie je sleutel, je thermostaten en de opslag van HomeyScript controleert en de regel voor de flow geeft.

## 0.1.0 (15 oktober 2026)

- Eerste versie: elke minuut kamertemperatuur en setpoint naar weheat-monitor.nl, en optioneel het plan volgen.
