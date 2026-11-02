# DRIFTING01

Drift Sogn Motorsportklubb's track at Kaupangerskogen in Sogndal, Norway: 479 m of asphalt, eleven
corners and 5 m of climb, measured from OpenStreetMap and Kartverket's terrain model. Pick a car in stock
trim or drift styling, hold the slide and chain the points. Keys or touch; on a phone, hold it sideways.

Play it on [zirbel.app](https://zirbel.app).

## Run, build and bundle

Node 22 or newer.

```
npm ci
npm run dev       # a dev server on port 5180
npm run build     # type-checks, then builds dist/
npm run bundle    # dist/ as a zirbel bundle, drifting01-<version>.tgz
```

## Controls

- Keyboard: W or ↑ gas, S or ↓ brake and reverse, A D or ← → steer, Space e-brake, C camera, R back on
  track, P pause, M sound.
- Touch: drag the left thumb sideways to steer; gas, brake and e-brake are on the right.

## Cars

The Pro-am car's model is in this repository. The AE86, R32 and E30 models are licensed for use inside the
game only, so their packed files (`src/assets/cars/*.car`) are not here, and a checkout without them offers
the Pro-am car alone. `tools/pack-cars.mjs` packs them from the source models.

## Licence and credits

The code is MIT (see `LICENSE`).

- Pro-am car: “Retro Car With Interior (PSX asset)” by [Bricchi Games](https://bricchi-games.itch.io/retro-car-with-interior), CC BY 4.0.
- AE86: “1986 Toyota Sprinter Trueno AE86 From Initial D” by [raddysa71arxi](https://www.cgtrader.com/free-3d-models/car/antique-car/1986-toyota-sprinter-trueno-ae86-from-initial-d), CGTrader Royalty Free.
- R32: “Nissan Skyline R32 GTR” by [13lue](https://www.cgtrader.com/free-3d-models/car/sport-car/nissan-skyline-r32-gtr-d4a3090d-61b3-4e1b-881b-9008ea7b7880), CGTrader Royalty Free.
- E30: “M3 e30” by [fadhilelouali6](https://www.cgtrader.com/3d-models/car/sport-car/m3-e30), CGTrader Royalty Free.
- Track: [OpenStreetMap](https://www.openstreetmap.org/way/516158930), © OpenStreetMap contributors, ODbL; traced
  against Esri World Imagery.
- Heights: © Kartverket, CC BY 4.0.
- Car and road graphics adapted from [derby01](https://github.com/matapao/derby01), MIT.
- 3D engine: [three.js](https://threejs.org), MIT.
