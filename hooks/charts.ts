// SVG drawings for the graphical surfaces (desktop, mobile, the editor). Each function takes the
// figures the mod already keeps and returns one self-contained <svg> string: an Svg element draws it
// isolated from the app, so colors live here, dark by default and paper under a light color scheme.
// The drawings carry no text: labels stay in Text beside them, so nothing ever sits on a mark.

export type Tone = 'ok' | 'warn' | 'bad'

const f = (n: number) => (Math.round(n * 10) / 10).toString()
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// The innerpulse grounds: carbon ink by night, paper by day
const STYLE = `<style>
.track{fill:#23272e}.fill{fill:#b9bdc3}.ok{fill:#7dd9a3}.warn{fill:#ffb347}.bad{fill:#f43a2a}
.read{fill:#4b5361}.write{fill:#ffb347}.fresh{fill:#e3e6e9}.out{fill:#8f949b}.sub{fill:#ff7a59}
.self{fill:#e3e6e9}.peer{fill:#5b6470}.share{fill:#e3e6e9}
.tick{stroke:#e3e6e9;stroke-opacity:.75}.ghost{stroke:#e3e6e9;stroke-opacity:.45;fill:none}
.miss{stroke:#f43a2a;fill:none}.base{stroke:#e3e6e9;stroke-opacity:.12}
.line{stroke:#b9bdc3;fill:none}.area{fill:#b9bdc3;fill-opacity:.08}.dot{fill:#f43a2a}
.c0{fill:#e3e6e9}.c1{fill:#9aa3b0}.c2{fill:#ff7a59}.c3{fill:#ffb347}.c4{fill:#6c7584}.c5{fill:#b38cff}.c6{fill:#7dd9a3}.c7{fill:#4b5361}
.g-ok{stop-color:#7dd9a3}.g-warn{stop-color:#ffb347}.g-bad{stop-color:#f43a2a}.ring{stroke:#1f2329}
.sl{fill:none;stroke:url(#sg)}.sa{fill:url(#sg);fill-opacity:.14}.se{fill:url(#sg)}
.pulse{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.35}}
@media (prefers-color-scheme:light){
.track{fill:#e6e0d6}.fill{fill:#454b56}.ok{fill:#0d6d3d}.warn{fill:#8b5109}.bad{fill:#d12c1e}
.read{fill:#b8b0a3}.write{fill:#c77a1a}.fresh{fill:#14171c}.out{fill:#575e6b}.sub{fill:#a83a18}
.self{fill:#14171c}.peer{fill:#a59d90}.share{fill:#14171c}
.tick{stroke:#14171c}.ghost{stroke:#14171c}.miss{stroke:#d12c1e}.base{stroke:#14171c;stroke-opacity:.15}
.line{stroke:#454b56}.area{fill:#454b56}.dot{fill:#d12c1e}
.g-ok{stop-color:#0d6d3d}.g-warn{stop-color:#c77a1a}.g-bad{stop-color:#d12c1e}.ring{stroke:#f4f1ec}
.c0{fill:#14171c}.c1{fill:#5d6573}.c2{fill:#a83a18}.c3{fill:#c77a1a}.c4{fill:#8a8f99}.c5{fill:#6a3fd0}.c6{fill:#0d6d3d}.c7{fill:#c9c1b4}}
@media (prefers-reduced-motion:reduce){.pulse{animation:none}}
</style>`

const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${STYLE}${body}</svg>`

const title = (t?: string) => (t ? `<title>${esc(t)}</title>` : '')

export type MeterOpts = {
  // 0..100
  value: number
  tone?: Tone
  // a tick across the track, 0..100 (where auto-compaction starts)
  mark?: number
  // a dashed run from the value to here, 0..100 (where the pace lands at the reset)
  ghost?: number
  // a highlighted run ending at the value, this long, 0..100 (this session's share)
  share?: number
  width?: number
  height?: number
  hint?: string
}

// A rounded level meter: the band's chips and the panel's limit rows
export function meter(o: MeterOpts): string {
  const w = o.width ?? 56
  const h = o.height ?? 8
  const pad = 3
  const iw = w - pad * 2
  const y = (h - Math.min(h, 6)) / 2
  const bh = Math.min(h, 6)
  const r = bh / 2
  const x = (p: number) => pad + (clamp(p, 0, 100) / 100) * iw
  const fill = `<rect class="${o.tone ?? 'fill'}" x="${pad}" y="${f(y)}" width="${f(Math.max(bh, x(o.value) - pad))}" height="${bh}" rx="${r}"/>`
  const share =
    o.share !== undefined && o.share > 0.05
      ? `<rect class="share" x="${f(x(o.value - o.share))}" y="${f(y)}" width="${f(Math.max(1.5, x(o.value) - x(o.value - o.share)))}" height="${bh}" rx="1"/>`
      : ''
  const ghost =
    o.ghost !== undefined && o.ghost > o.value + 0.5
      ? `<line class="ghost" x1="${f(x(o.value) + 1)}" x2="${f(x(o.ghost))}" y1="${f(h / 2)}" y2="${f(h / 2)}" stroke-width="1.5" stroke-dasharray="2 2"/>` +
        `<line class="ghost" x1="${f(x(o.ghost))}" x2="${f(x(o.ghost))}" y1="${f(y - 1)}" y2="${f(y + bh + 1)}" stroke-width="1.5"/>`
      : ''
  const mark =
    o.mark !== undefined
      ? `<line class="tick" x1="${f(x(o.mark))}" x2="${f(x(o.mark))}" y1="0" y2="${h}" stroke-width="1.5"/>`
      : ''
  return svg(w, h, `${title(o.hint)}<rect class="track" x="${pad}" y="${f(y)}" width="${iw}" height="${bh}" rx="${r}"/>${fill}${share}${ghost}${mark}`)
}

export type TurnBar = { read: number; write: number; fresh: number; output: number; isMiss: boolean; hint: string }

// The band's sparkline: the last turns' prompt sizes as one thin line over a faint fill, shaded green
// at the low end of its range to red at the high, a miss as a ringed red dot, the running turn's end pulsing. Each turn keeps an invisible slot for its tooltip.
export function spark(turns: TurnBar[], isLive: boolean, width = 72, height = 16, hint?: string): string {
  if (turns.length === 0) return svg(width, height, title(hint))
  const sizes = turns.map(t => t.read + t.write + t.fresh)
  const max = Math.max(1, ...sizes)
  // From a little under the smallest turn, so the line shows its shape; the tooltips carry the figures
  const min = Math.min(...sizes) * 0.8
  const pad = 2.5
  const ih = height - pad * 2
  const x = (i: number) => (turns.length === 1 ? width / 2 : pad + (i / (turns.length - 1)) * (width - pad * 2))
  const y = (v: number) => pad + ih - ((v - min) / Math.max(1, max - min)) * ih
  const pts = sizes.map((v, i) => `${f(x(i))},${f(y(v))}`)
  const area =
    turns.length > 1
      ? `<path class="sa" d="M${f(x(0))},${height} L${pts.join(' L')} L${f(x(turns.length - 1))},${height} Z"/>`
      : ''
  const line = turns.length > 1 ? `<polyline class="sl" points="${pts.join(' ')}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>` : ''
  const slot = width / turns.length
  const marks = turns
    .map((t, i) => {
      const last = i === turns.length - 1
      const dot = t.isMiss
        ? `<circle class="dot ring" cx="${f(x(i))}" cy="${f(y(sizes[i]!))}" r="2.25" stroke-width="1"/>`
        : last
          ? `<circle class="se${isLive ? ' pulse' : ''}" cx="${f(x(i))}" cy="${f(y(sizes[i]!))}" r="1.75"/>`
          : ''
      return `<g>${title(t.hint)}<rect x="${f(i * slot)}" y="0" width="${f(slot)}" height="${height}" fill="transparent"/>${dot}</g>`
    })
    .join('')
  // Top of the range red, the middle amber, the bottom green, in the drawing's own coordinates
  const grad =
    `<defs><linearGradient id="sg" gradientUnits="userSpaceOnUse" x1="0" y1="${pad}" x2="0" y2="${height - pad}">` +
    `<stop class="g-bad" offset="0"/><stop class="g-warn" offset=".5"/><stop class="g-ok" offset="1"/></linearGradient></defs>`
  return svg(width, height, `${grad}${title(hint)}<rect width="${width}" height="${height}" fill="transparent"/>${area}${line}${marks}`)
}

// The panel's turn chart: stacked columns (cache read, cache written, uncached), output as a thin
// column beside each, misses ringed in ember
export function turnChart(turns: TurnBar[], width: number, height = 96): string {
  if (turns.length === 0) return svg(width, height, '')
  const top = 6
  const ch = height - top - 2
  const max = Math.max(1, ...turns.map(t => t.read + t.write + t.fresh))
  const maxOut = Math.max(1, ...turns.map(t => t.output))
  const n = Math.max(turns.length, 12)
  const slot = width / n
  const bw = Math.max(3, slot * 0.58)
  const ow = Math.max(1.5, slot * 0.14)
  const cols = turns
    .map((t, i) => {
      const x = i * slot + (slot - bw - ow - 1.5) / 2
      const scale = (v: number) => (v / max) * ch
      let y = top + ch
      const seg = (cls: string, v: number) => {
        const hh = scale(v)
        if (hh <= 0) return ''
        y -= hh
        return `<rect class="${cls}" x="${f(x)}" y="${f(y)}" width="${f(bw)}" height="${f(Math.max(0.8, hh))}"/>`
      }
      const parts = seg('read', t.read) + seg('write', t.write) + seg('fresh', t.fresh)
      const oh = Math.max(1, (t.output / maxOut) * ch * 0.5)
      const out = `<rect class="out" x="${f(x + bw + 1.5)}" y="${f(top + ch - oh)}" width="${f(ow)}" height="${f(oh)}" rx=".5"/>`
      const ring = t.isMiss
        ? `<rect class="miss" x="${f(x - 1.5)}" y="${f(y - 1.5)}" width="${f(bw + 3)}" height="${f(top + ch - y + 1.5)}" rx="1.5" stroke-width="1.5"/>`
        : ''
      // the hover target spans the whole slot, so thin columns are easy to find
      return `<g>${title(t.hint)}<rect x="${f(i * slot)}" y="0" width="${f(slot)}" height="${height}" fill="transparent"/>${parts}${out}${ring}</g>`
    })
    .join('')
  return svg(width, height, `<line class="base" x1="0" x2="${width}" y1="${top + ch + 0.5}" y2="${top + ch + 0.5}"/>${cols}`)
}

// The context's makeup as one stacked bar, with a tick where auto-compaction starts
export function stack(parts: { tokens: number; hint: string }[], window: number, mark: number | undefined, width: number, height = 14): string {
  const total = Math.max(window, 1)
  let x = 0
  const segs = parts
    .map((p, i) => {
      const w = (p.tokens / total) * width
      const s = `<rect class="c${i % 8}" x="${f(x)}" y="2" width="${f(Math.max(0.8, w - 1))}" height="${height - 4}">${title(p.hint)}</rect>`
      x += w
      return s
    })
    .join('')
  const tick =
    mark !== undefined
      ? `<line class="tick" x1="${f((mark / total) * width)}" x2="${f((mark / total) * width)}" y1="0" y2="${height}" stroke-width="1.5"/>`
      : ''
  return svg(width, height, `<rect class="track" x="0" y="2" width="${width}" height="${height - 4}" rx="2"/>${segs}${tick}`)
}

// The context after each turn as a line, with the compaction threshold dashed across
export function contextLine(history: number[], window: number, mark: number | undefined, width: number, height = 44): string {
  if (history.length < 2) return svg(width, height, '')
  const top = 3
  const ch = height - top - 2
  const y = (v: number) => top + ch - (clamp(v, 0, window) / window) * ch
  const x = (i: number) => (i / (history.length - 1)) * (width - 4) + 2
  const pts = history.map((v, i) => `${f(x(i))},${f(y(v))}`)
  const area = `<path class="area" d="M${f(x(0))},${top + ch} L${pts.join(' L')} L${f(x(history.length - 1))},${top + ch} Z"/>`
  const line = `<polyline class="line" points="${pts.join(' ')}" stroke-width="1.5" stroke-linejoin="round"/>`
  const thr =
    mark !== undefined
      ? `<line class="ghost" x1="0" x2="${width}" y1="${f(y(mark))}" y2="${f(y(mark))}" stroke-dasharray="3 3"/>`
      : ''
  const last = history[history.length - 1]!
  const end = `<circle class="dot" cx="${f(x(history.length - 1))}" cy="${f(y(last))}" r="2.5"/>`
  return svg(width, height, `<line class="base" x1="0" x2="${width}" y1="${top + ch + 0.5}" y2="${top + ch + 0.5}"/>${area}${thr}${line}${end}`)
}

// One session's week spend against the busiest session's, for the panel's session rows
export function spendBar(value: number, max: number, isSelf: boolean, width = 96, height = 8): string {
  const w = max <= 0 ? 0 : (value / max) * width
  return svg(width, height, `<rect class="track" x="0" y="1" width="${width}" height="${height - 2}" rx="1.5"/><rect class="${isSelf ? 'self' : 'peer'}" x="0" y="1" width="${f(Math.max(1, w))}" height="${height - 2}" rx="1.5"/>`)
}

// A small square of a series' color, for a Text legend beside a chart
export function swatch(cls: string, size = 8): string {
  return svg(size, size, `<rect class="${cls}" x="0" y="0" width="${size}" height="${size}" rx="1.5"/>`)
}
