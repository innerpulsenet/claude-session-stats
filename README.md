# session-stats

A Claude Code mod that shows this session's usage in a one-line band above the prompt box, with a details panel beside the chat.

**The band**

```
turn in 85k out 3k · in 1.2M out 48k · cache 91% · ctx 34% (compacts ~6 turns) · $3.12 · week 41% (+2.5%) → 78% at reset   [Details] [Hide]
```

- **turn**: the running turn's tokens, shown while Claude works.
- **in / out**: the session's prompt tokens (uncached + cache read + cache written) and output tokens, subagents included.
- **cache**: the share of prompt tokens the prompt cache served. It shows **⚠ miss** when a request had to re-send its prefix uncached, usually after the cache expired while the session sat idle. Each miss also raises a toast.
- **ctx**: how full the context window is, and roughly how many turns are left before auto-compaction.
- **$**: the session's cost, as `/cost` gives it.
- **week**: the weekly limit, this session's share of it, and where the account's pace lands at the reset. If the pace fills the week before the reset, it says when, in red. The 5-hour window shows up from 50%, or sooner if it's on pace to fill.

**The panel** (Details, or `/session-stats`)

- **Tokens:** uncached / cache read / cache written; main vs subagents; cache misses and tokens re-sent; $/hour.
- **Limits:** each window with a bar, reset time, this session's share, pace per hour, and the forecast.
- **Context:** fill, auto-compact point, and what fills it (messages, tools, memory files…).
- **Recent turns:** a bar per turn, misses in red.
- **By model** and **Sessions this week**, for every session the mod has run in.

**Charts on desktop and mobile.** In the desktop app, the mobile app and the editor, the band and the panel draw SVG instead of block characters; the terminal keeps the text version above.

- **The band:** a small line of the last turns' prompt sizes, shaded from green at its lowest to red at its highest (a cache miss as a ringed red dot, the running turn's end pulsing; hover it for each turn and the session's totals), the running turn's elapsed time and tokens while Claude works, the cache rate (dim while healthy), cost, context as a percentage, and a meter for the 5-hour and weekly limits with their reset times. Groups are parted by a dim bar. A meter's color is its level: green, amber near the limit, red past it or on pace to fill before the reset. This session's share of the week is the light segment at the end of its fill; the dashed run is where the pace lands at the reset. When the column is narrow, the asides drop first, then the cost; the limits always stay.
- **The panel:** limit meters with the same share and forecast, the context over the last turns against the compaction line, what fills the context as one stacked bar, the recent turns as stacked columns (cache read, cache written, uncached, with output beside each and misses ringed in red), and a spend bar per session. Hover any mark for its figures.
- Colors follow light and dark mode. The pulse stops under reduced motion.

**How it works out each session's share.** Each session the mod runs in keeps a small record (its cost over time and the limit readings it saw) in the mod's own storage. When the weekly limit rises, each session takes a share in proportion to what it spent while it rose. Sessions run without the mod can't be counted.

## Install

At the prompt of a terminal session:

```
/plugin install session-stats --marketplace innerpulsenet/claude-session-stats
```

From a shell:

```bash
claude plugin install session-stats --marketplace innerpulsenet/claude-session-stats
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `innerpulsenet/claude-session-stats`, then Add plugin.

## Update

When a new version is pushed:

```bash
claude plugin marketplace update innerpulsenet
```

```bash
claude plugin update session-stats
```

Then run `/reload-plugins` in an open session, or start a new one.
