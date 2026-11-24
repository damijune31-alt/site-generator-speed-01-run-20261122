# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/damijune31-alt/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/damijune31-alt/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free static site generator matching makefun-site 1.0.0 byte for byte, ~3x faster on the practice set. Templates compile once per case into flat opcodes run by a tight interpreter, Markdown is scanned line by line without per-line regexes, and the inline renderer jumps between special characters with a single native regex scan. Practice set: 3/3 cases byte-exact; `run()` CPU ~210–255k µs vs ~690k µs for the reference.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` reads `cases.json` from `MAKEFUN_INPUT_DIR` (or `/input`) and writes `answers.json` to `MAKEFUN_OUTPUT_DIR` (or `/output`). `solve.js` is a dependency-free ES module exporting `run(input)`; it keeps nothing from one `run()` call to the next.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x9vj0gh6&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
