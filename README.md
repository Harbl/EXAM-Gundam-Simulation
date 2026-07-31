# Gundam TCG Sim

Windows desktop app (Electron) that simulates batches of Gundam Card Game matches
between two pasted decklists and reports aggregate stats (win rate, mulligan rate,
opening-hand curve quality, game length).

Built against the official Comprehensive Rules (v1.8.0) and the July 2026
banned/restricted list. Card effects are only ever implemented from verified
real card text — never guessed.

## Running in dev

```
npm install
npm start
```

## Running the engine standalone (no window)

```
npm run sim -- deckA.txt deckB.txt --games 1000
```

## Building the Windows installer

```
npm run dist
```

## Adding a new card

If a pasted decklist references a card number not yet in `src/cards/`, the app
will refuse to simulate and list exactly which card numbers are missing. To add
one:

1. Research its real text (level, cost, color, AP/HP, traits, keywords, full effect).
2. Add an entry to the matching set file in `src/cards/` (e.g. `src/cards/GD01.json`).
3. If its effect isn't already covered by an existing function in `src/effects/`,
   add a new named effect function there and reference it from the card entry.

Cards are cumulative — once added, they're available to every future decklist.
