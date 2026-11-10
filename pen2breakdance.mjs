#!/usr/bin/env node
// pen2bd — exporte une maquette pen.dev en fichiers JSON prêts à coller dans Breakdance
// (même format que Headspin : {"source":..., "element":{...}}).
//
// Usage : se placer dans le dossier qui contient le .pen, puis
//   pen2bd                 → exporte le .pen du dossier dans ./export/
//   pen2bd maquette.pen    → choisit le fichier si le dossier en contient plusieurs
// Options : --out dossier   --media-url https://site.fr/wp-content/uploads/2026/11/
// Réglages persistants : pen2bd.config.json (créé au premier lancement, à côté du .pen)
// Prérequis : Node 18+, application pen.dev ouverte.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readDocument } from "./pen-mcp.mjs";

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const SOURCE = "pen.dev";
const fail = msg => { console.error("✖ " + msg); process.exit(1); };

if (args.includes("--help") || args.includes("-h")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 11).map(l => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}

// ---------- fichier .pen ----------
let penFile = positional[0];
if (!penFile) {
  const pens = fs.readdirSync(process.cwd()).filter(f => f.endsWith(".pen"));
  if (!pens.length) fail(`Aucun fichier .pen dans ${process.cwd()}`);
  if (pens.length > 1) fail(`Plusieurs .pen dans ce dossier, précise lequel : pen2bd ${pens.map(p => `"${p}"`).join(" | ")}`);
  penFile = pens[0];
}
penFile = path.resolve(penFile);
if (!fs.existsSync(penFile)) fail(`Fichier introuvable : ${penFile}`);
const DIR = path.dirname(penFile);

// ---------- configuration ----------
const CONFIG_FILE = path.join(DIR, "pen2bd.config.json");
const defaultPrefix = path.basename(penFile, ".pen").split(/[_\-. ]/)[0].toLowerCase().replace(/[^a-z0-9]/g, "") || "pen";
let config = { prefix: defaultPrefix, mediaUrl: "", mediaFormat: "webp" };
let firstRun = false;
if (fs.existsSync(CONFIG_FILE)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; } catch (e) { fail(`pen2bd.config.json invalide : ${e.message}`); }
} else {
  firstRun = true;
}
if (opt("media-url") !== undefined) config.mediaUrl = opt("media-url");
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");

const OUT = path.resolve(opt("out") ?? path.join(DIR, "export"));
const PREFIX = config.prefix;
const MEDIA_URL = config.mediaUrl ? config.mediaUrl.replace(/\/?$/, "/") : "";
const MEDIA_EXT = config.mediaFormat ? "." + config.mediaFormat.replace(/^\./, "") : null;

let dump;
try { dump = await readDocument(penFile); }
catch (e) { fail(e.message); }
const VARS = dump.variables || {};

// ---------- composants pen.dev ----------
// Une instance (type "ref") pointe vers un cadre "reusable" ; elle peut surcharger ses propres propriétés
// et celles de ses descendants (descendants : { id: {props} } ou nœud complet s'il a un "type").
// On remplace chaque instance par une copie résolue du composant, avant toute conversion.
const COMPONENTS = new Map();
(function collect(n) {
  if (!n || typeof n !== "object") return;
  if (n.reusable && n.id) COMPONENTS.set(n.id, n);
  (n.children || []).forEach(collect);
})({ children: dump.pages.flatMap(p => p.sections) });

function resolveRefs(n, overrides = {}, depth = 0) {
  if (!n || typeof n !== "object") return n;
  const own = overrides[n.id];
  if (own?.type) n = own;                              // remplacement complet du nœud
  else if (own) n = { ...n, ...own };
  if (n.type === "ref" && depth < 20) {
    const comp = COMPONENTS.get(n.ref);
    if (!comp) return n;
    const { type, ref, descendants, ...instance } = n;
    // surcharges : celles de l'instance l'emportent ; un id "a/b" vise b à l'intérieur du composant imbriqué a
    const sub = { ...overrides, ...Object.fromEntries(Object.entries(descendants || {}).map(([k, v]) => [k.split("/").pop(), v])) };
    const { reusable, ...base } = comp;
    return resolveRefs({ ...structuredClone(base), ...instance }, sub, depth + 1);
  }
  const out = { ...n };
  delete out.reusable;
  if (n.children) out.children = n.children.map(c => resolveRefs(c, overrides, depth));
  return out;
}
for (const page of dump.pages) page.sections = page.sections.map(s => resolveRefs(s));
let PAGE_WIDTH = 1440;
let FONTS = { heading: null, body: null };
// Liens du header / footer
const pageTitle = name => String(name || "").replace(/\s*[—–-]\s*(ordinateur|desktop|tablette|tablet|mobile|phone)\b.*$/i, "").trim();
let ZONE = null;              // "header" | "footer" | null pendant la conversion d'une section
const zoneName = name => /header|en-?t[êe]te|navbar|navigation principale/i.test(name || "") ? "header"
  : /footer|pied/i.test(name || "") ? "footer" : null;
let LINK_TARGETS = [];        // [{ name, slug, url }] : sections de la page (ancres) et autres pages
const anchorsNeeded = new Map(); // slug → nom de la section à qui donner cet ID

let nextId = 1000;

// ---------- helpers valeurs ----------
const bp = v => ({ breakpoint_base: v });
const px = n => ({ number: n, unit: "px", style: `${n}px` });
const custom = s => ({ number: s, unit: "custom", style: String(s) });
const isVar = v => typeof v === "string" && v.startsWith("$");
// valeur d'une variable pen (première valeur si thèmes), résolue récursivement
const varValue = v => { const d = VARS[v.slice(1)]; if (!d) return undefined; const val = Array.isArray(d.value) ? d.value[0]?.value : d.value; return isVar(val) ? varValue(val) : val; };
const resolve = v => isVar(v) ? varValue(v) : v;
// Variables couleur → palette Breakdance (Global Settings > Colors > Palette)
// Nom au format Breakdance « bde-palette-<nom>-<uuid> », uuid stable dérivé du nom pour que les réexports restent liés.
const stableUuid = seed => { const h = createHash("md5").update(seed).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`; };
const slugify = s => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const paletteName = k => `bde-palette-${slugify(k)}-${stableUuid(`${PREFIX}:${k}`)}`;
const isColorVar = v => isVar(v) && VARS[v.slice(1)]?.type === "color";
// valeur numérique pen (nombre ou $variable) -> unité Breakdance (les variables numériques sont résolues)
const num = v => px(resolve(v));
const numCss = v => `${resolve(v)}px`;
// police Google → identifiant Breakdance (ex. « Brygada 1918 » → gfont-brygada1918)
const gfont = family => family ? "gfont-" + String(family).toLowerCase().replace(/[^a-z0-9]/g, "") : null;

function hexToCss(hex) {
  if (!hex || !hex.startsWith("#")) return hex;
  const h = hex.slice(1);
  if (h.length === 8) {
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = +(parseInt(h.slice(6, 8), 16) / 255).toFixed(3);
    return a === 1 ? `#${h.slice(0, 6)}` : `rgba(${r},${g},${b},${a})`;
  }
  return hex;
}
const color = v => isColorVar(v) ? `var(--${paletteName(v.slice(1))})` : hexToCss(resolve(v));

function deepSet(obj, pathStr, value) {
  if (value === undefined || value === null) return;
  const keys = pathStr.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

const sides = p => {
  if (p === undefined) return null;
  if (!Array.isArray(p)) return { top: p, right: p, bottom: p, left: p };
  if (p.length === 2) return { top: p[0], right: p[1], bottom: p[0], left: p[1] };
  return { top: p[0], right: p[1], bottom: p[2], left: p[3] };
};
const spacingObj = s => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== 0 && v !== undefined).map(([k, v]) => [k, num(v)]));

const JUSTIFY = { start: "flex-start", center: "center", end: "flex-end", space_between: "space-between", space_around: "space-around" };
const ALIGN = { start: "flex-start", center: "center", end: "flex-end" };

const layoutOf = n => n.type === "frame" ? (n.layout ?? "horizontal") : null;

// ---------- fonds ----------
function fillsOf(n) { return n.fill === undefined ? [] : (Array.isArray(n.fill) ? n.fill : [n.fill]).filter(f => typeof f === "string" || f.enabled !== false); }

// pen : rotation en degrés anti-horaires depuis le haut, la position 0 → 1 suit cette direction
// CSS / Breakdance : degrés horaires depuis le haut → angle = -rotation
const cssAngle = f => { const d = (-(resolve(f.rotation) ?? 0)) % 360; return Math.round((d + 360) % 360 * 1000) / 1000; };
const stopPos = c => (isVar(c.position) ? 0 : c.position);

function gradientCss(f) {
  const stops = (f.colors || []).map(c => `${color(c.color)} ${Math.round(stopPos(c) * 100)}%`).join(", ");
  return f.gradientType === "radial" ? `radial-gradient(${stops})` : `linear-gradient(${cssAngle(f)}deg, ${stops})`;
}

// couleur pen (hex ou variable) → {r,g,b,a}
function rgba(v) {
  const h = String(resolve(v) || "#000000").replace("#", "");
  const full = h.length <= 4 ? [...h].map(c => c + c).join("") : h;
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: full.length >= 8 ? +(parseInt(full.slice(6, 8), 16) / 255).toFixed(3) : 1 };
}
const r6 = x => Math.round(x * 1e6) / 1e6;

// Dégradé linéaire → overlay natif Breakdance (format relevé dans un export Breakdance réel)
function gradientOverlay(f) {
  const deg = cssAngle(f), rad = deg * Math.PI / 180;
  const sin = Math.sin(rad) / 2, cos = Math.cos(rad) / 2;
  const stops = (f.colors || []).map(c => ({ ...rgba(c.color), pos: stopPos(c) }));
  const svgStops = stops.map(s => `<stop stop-opacity="${s.a}" stop-color="#${[s.r, s.g, s.b].map(x => x.toString(16).padStart(2, "0")).join("")}" offset="${s.pos}"></stop>`).join("");
  return {
    type: "gradient",
    gradient: {
      points: stops.map(s => ({ left: s.pos * 100, red: s.r, green: s.g, blue: s.b, alpha: s.a })),
      type: "linear",
      degree: deg,
      svgValue: `<linearGradient x1="${r6(0.5 - sin)}" y1="${r6(0.5 + cos)}" x2="${r6(0.5 + sin)}" y2="${r6(0.5 - cos)}" id="%%GRADIENTID%%">${svgStops}</linearGradient>`,
      value: `linear-gradient(${deg}deg,${stops.map(s => `rgba(${s.r}, ${s.g}, ${s.b}, ${s.a}) ${s.pos * 100}%`).join(",")})`,
    },
  };
}

// Nom que WordPress donnera au fichier une fois converti et importé
const media = new Map(); // chemin pen → nom WordPress
function wpName(url) {
  let name = decodeURIComponent(url.split(/[\\/]/).pop());
  if (MEDIA_EXT) name = name.replace(/\.[a-z0-9]+$/i, "") + MEDIA_EXT;
  return name.replace(/[?\[\]\/\\=<>:;,'"&$#*()|~`!{}%+’«»”“\u00a0]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}
function mediaFromUrl(url) {
  const filename = wpName(url);
  media.set(url, filename);
  const full = MEDIA_URL ? MEDIA_URL + encodeURIComponent(filename) : filename;
  const mime = /\.webp$/i.test(filename) ? "image/webp" : /\.png$/i.test(filename) ? "image/png" : /\.svg$/i.test(filename) ? "image/svg+xml" : "image/jpeg";
  return { id: null, filename, url: full, alt: "", caption: "", mime, type: "image", sizes: {}, attributes: {} };
}

// Dégradés uniquement en réglages natifs, jamais en CSS. Breakdance offre deux emplacements :
// l'overlay (au-dessus) et le fond lui-même (design.background.type = gradient, impossible avec une image de fond).
// Les fills pen s'empilent du bas vers le haut : le dernier dégradé va dans l'overlay, le précédent dans le fond.
function applyBackground(props, n) {
  const gradients = [];
  let hasImage = false;
  for (const f of fillsOf(n)) {
    if (typeof f === "string" || f.type === "color") {
      deepSet(props, "design.background.color", color(typeof f === "string" ? f : f.color));
    } else if (f.type === "image" && f.url) {
      hasImage = true;
      deepSet(props, "design.background.type", "image");
      deepSet(props, "design.background.image", bp(mediaFromUrl(f.url)));
      if (f.mode === "contain" || f.mode === "stretch") warnings.push(`« ${n.name} » : image de fond en mode ${f.mode}, à régler dans Breakdance`);
    } else if (f.type === "gradient") {
      if (f.gradientType === "radial" || f.gradientType === "angular") warnings.push(`« ${n.name} » : dégradé ${f.gradientType} (${gradientCss(f)}), à régler dans Breakdance (Background)`);
      else gradients.push(f);
    }
  }
  const top = gradients.pop();
  if (top) deepSet(props, "design.background.overlay", gradientOverlay(top));
  const under = hasImage ? null : gradients.pop();
  if (under) {
    deepSet(props, "design.background.type", "gradient");
    deepSet(props, "design.background.gradient", gradientOverlay(under).gradient);
  }
  for (const f of gradients) warnings.push(`« ${n.name} » : dégradé supplémentaire (${gradientCss(f)}), à régler dans Breakdance`);
}

// ---------- bordures / rayons / effets ----------
function bordersObj(n) {
  const out = {};
  if (n.stroke !== undefined) {
    const sc = color(typeof n.stroke === "string" ? n.stroke : n.stroke.color ?? n.stroke[0]);
    const sw = n.strokeWidth ?? 1;
    const per = typeof sw === "object" ? sw : { top: sw, right: sw, bottom: sw, left: sw };
    const border = {};
    for (const s of ["top", "right", "bottom", "left"]) if (per[s]) border[s] = { width: num(per[s]), style: "solid", color: sc };
    if (Object.keys(border).length) out.border = bp(border);
  }
  if (n.cornerRadius !== undefined) {
    const r = Array.isArray(n.cornerRadius) ? n.cornerRadius : [n.cornerRadius, n.cornerRadius, n.cornerRadius, n.cornerRadius];
    const all = r.every(x => x === r[0]);
    out.radius = bp({ all: num(r[0]), topLeft: num(r[0]), topRight: num(r[1]), bottomRight: num(r[2]), bottomLeft: num(r[3]), editMode: all ? "all" : "custom" });
  }
  return Object.keys(out).length ? out : null;
}

function borderCss(n, css) {
  if (n.stroke === undefined) return;
  const sc = color(typeof n.stroke === "string" ? n.stroke : n.stroke.color ?? n.stroke[0]);
  const sw = n.strokeWidth ?? 1;
  const per = typeof sw === "object" ? sw : { top: sw, right: sw, bottom: sw, left: sw };
  for (const side of ["top", "right", "bottom", "left"]) if (per[side]) css.push(`border-${side}: ${numCss(per[side])} solid ${sc};`);
}

function effectsCss(n, css) {
  const effs = n.effect === undefined ? [] : Array.isArray(n.effect) ? n.effect : [n.effect];
  const shadows = effs.filter(e => e.type === "shadow" && e.enabled !== false)
    .map(e => `${e.shadowType === "inner" ? "inset " : ""}${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.blur ?? 0}px ${color(e.color ?? "#00000040")}`);
  if (shadows.length) css.push(`box-shadow: ${shadows.join(", ")};`);
  for (const e of effs) if (e.type === "background_blur" && e.enabled !== false) css.push(`backdrop-filter: blur(${e.radius ?? 8}px);`);
  if (n.opacity !== undefined && n.opacity !== 1) css.push(`opacity: ${n.opacity};`);
}

// ---------- grilles ----------
// pen.dev n'a pas de grille : on la reconnaît à sa structure.
//  A. frame vertical composé uniquement de rangées horizontales identiques (même nombre de cellules,
//     toutes en fill_container ; la dernière rangée peut être incomplète), rangées sans fond ni padding
//  B. rangée horizontale d'au moins 3 cartes identiques (frames ou composants) en fill_container
// → Div en layout Grid natif (Items Per Row), les cellules deviennent enfants directs.
const GRID_PARENT = { type: "frame", layout: "vertical" };
const visible = n => (n.children || []).filter(c => c.enabled !== false);
const isFill = w => w === "fill_container" || (typeof w === "string" && w.startsWith("fill_container"));
const isCard = c => (c.type === "frame" || c.type === "ref") && !isButton(c) && isFill(c.width);
// cellule en fill_container de hauteur dans une rangée de hauteur fixe → hauteur de la rangée
const cellOf = (c, row) => (isFill(c.height) && typeof row.height === "number") ? { ...c, height: row.height } : c;

function gridOf(n, parent) {
  if (n.type !== "frame") return null;
  const kids = visible(n);
  const layout = layoutOf(n);
  if (layout === "vertical" && kids.length >= 2 && kids.every(r => layoutOf(r) === "horizontal" && fillsOf(r).length === 0 && !r.padding && r.stroke === undefined)) {
    const rows = kids.map(visible);
    const N = rows[0].length;
    const sameCount = rows.every((r, i) => i === rows.length - 1 ? r.length >= 1 && r.length <= N : r.length === N);
    if (N >= 2 && sameCount && rows.every(r => r.every(c => isFill(c.width) && c.type !== "text")))
      return { cols: N, cells: rows.flatMap((r, i) => r.map(c => cellOf(c, kids[i]))), gap: kids[0].gap, rowGap: n.gap };
  }
  // rangée d'une grille irrégulière (ex. une carte plus large par rangée) : on laisse en flex
  const rowOfStack = parent && layoutOf(parent) === "vertical" && visible(parent).filter(r => r !== n && layoutOf(r) === "horizontal" && visible(r).length === kids.length).length > 0;
  if (layout === "horizontal" && kids.length >= 3 && !rowOfStack && kids.every(isCard))
    return { cols: kids.length, cells: kids.map(c => cellOf(c, n)), gap: n.gap, rowGap: n.gap };
  return null;
}

// ---------- dimensions ----------
function sizing(n, parent, css, kind /* div | text | image */) {
  const pl = parent ? layoutOf(parent) : null;
  const w = n.width, h = n.height;
  const wPath = kind === "div" ? "design.container.width" : kind === "image" ? "design.image.width" : "design.size.width";
  const out = {};
  if (w === "fill_container" || (typeof w === "string" && w.startsWith("fill_container"))) {
    if (pl === "horizontal") css.push("flex: 1 1 0;", "min-width: 0;");
    else out[wPath] = bp({ number: 100, unit: "%", style: "100%" });
  } else if (typeof w === "number" || isVar(w)) {
    if (kind === "text" && n.textGrowth !== "fixed-width" && n.textGrowth !== "fixed-width-height") { /* auto : largeur ignorée */ }
    else {
      out[wPath] = bp(num(w));
      if (kind === "div") css.push("max-width: 100%;");
      if (pl === "horizontal" && kind === "div") css.push("flex-shrink: 0;");
    }
  }
  if (h === "fill_container" || (typeof h === "string" && h.startsWith("fill_container"))) {
    if (pl === "vertical") css.push("flex: 1 1 0;"); else css.push("align-self: stretch;");
  } else if ((typeof h === "number" || isVar(h)) && kind !== "text") {
    if (kind === "div") out["design.container.min_height"] = bp(num(h));
    else if (kind === "image") out["design.image.height"] = bp(num(h));
  }
  return out;
}

// ---------- typographie ----------
function typography(props, t, css) {
  const base = "design.typography.typography.custom.customTypography";
  if (t.fontSize !== undefined) deepSet(props, `${base}.fontSize`, bp(num(t.fontSize)));
  if (t.fontWeight !== undefined) deepSet(props, `${base}.fontWeight`, bp(t.fontWeight === "normal" ? "400" : t.fontWeight === "bold" ? "700" : String(t.fontWeight)));
  if (t.lineHeight !== undefined) deepSet(props, `${base}.advanced.lineHeight`, bp(custom(String(t.lineHeight))));
  if (t.letterSpacing) deepSet(props, `${base}.advanced.letterSpacing`, bp(num(t.letterSpacing)));
  if (t.fontStyle === "italic") css.push("font-style: italic;");
  if (t.underline) css.push("text-decoration: underline;");
  if (t.textAlign) css.push(`text-align: ${t.textAlign};`);
  // police : rien si c'est la police globale (titres ou texte), sinon réglage natif de l'élément
  const fam = resolve(t.fontFamily);
  if (fam && fam !== (headingTag(t) ? FONTS.heading : FONTS.body)) deepSet(props, `${base}.fontFamily`, bp(gfont(fam)));
  const fill = fillsOf(t)[0];
  if (fill) deepSet(props, "design.typography.color", bp(color(typeof fill === "string" ? fill : fill.color)));
}

// ---------- icônes (lucide via unpkg, mis en cache) ----------
const iconCache = {};
async function iconSvg(lib, name) {
  const key = `${lib}/${name}`;
  if (iconCache[key] !== undefined) return iconCache[key];
  const urls = {
    lucide: `https://unpkg.com/lucide-static@0.460.0/icons/${name}.svg`,
    feather: `https://unpkg.com/feather-icons@4.29.2/dist/icons/${name}.svg`,
    phosphor: `https://unpkg.com/@phosphor-icons/core@2.1.1/assets/regular/${name}.svg`,
  };
  let svg = null;
  try { if (urls[lib]) { const r = await fetch(urls[lib]); if (r.ok) svg = (await r.text()).replace(/<!--[\s\S]*?-->/g, "").trim(); } } catch {}
  return (iconCache[key] = svg);
}

// ---------- détection ----------
const textNodes = n => n.type === "text" ? [n] : (n.children || []).flatMap(textNodes);
const isButton = n => n.type === "frame" && n.children?.length && n.children.length <= 2 && (n.layout ?? "horizontal") === "horizontal"
  && n.children.filter(c => c.type === "text").length === 1 && n.children.every(c => c.type === "text" || c.type === "icon")
  && (fillsOf(n).length || n.stroke !== undefined) && (n.padding !== undefined);
const headingTag = t => {
  const m = /^h([1-6])\b/i.exec(t.name || "");
  if (m) return `h${m[1]}`;
  const fs = typeof t.fontSize === "number" ? t.fontSize : 16;
  if (fs >= 40) return "h2";
  if (fs >= 24) return "h3";
  return null;
};

// ---------- conversion ----------
const warnings = [];

function finishCss(props, css) {
  if (css.length) deepSet(props, "settings.advanced.css", bp(`%%SELECTOR%% {\n  ${[...new Set(css)].join("\n  ")}\n}`));
}

function el(type, props, parentId, name) {
  if (name) deepSet(props, "meta.friendlyName", name);
  return { id: nextId++, data: { type: `EssentialElements\\${type}`, properties: Object.keys(props).length ? props : null }, children: [], _parentId: parentId };
}

function absCss(n, css) {
  if (n.layoutPosition === "absolute" || n._absParent) css.push("position: absolute;", `left: ${n.x ?? 0}px;`, `top: ${n.y ?? 0}px;`);
}

// ---------- liens (header / footer) ----------
const SOCIAL = /^(linkedin|facebook|instagram|youtube|tiktok|twitter|x|pinterest|whatsapp)$/i;
const LEGAL = /mentions l[ée]gales|confidentialit|cgv|conditions g[ée]n[ée]rales|plan du site|cookies/i;

// Lien déduit d'un texte : href pen.dev, téléphone, e-mail, ou nom d'une section / page. Sinon null.
function linkFor(t) {
  if (t.href) return t.href;
  const txt = String(t.content ?? "").trim();
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(txt)) return `mailto:${txt}`;
  const digits = txt.replace(/[\s.\-()]/g, "");
  if (/^\+?\d{9,15}$/.test(digits)) return `tel:${digits}`;
  const sl = slugify(txt.replace(/\*/g, ""));
  if (!sl) return null;
  if (/^(accueil|home)$/.test(sl)) return "/";
  const target = LINK_TARGETS.find(x => x.slug === sl) || LINK_TARGETS.find(x => x.slug.startsWith(sl + "-"));
  if (!target) return null;
  if (target.url.startsWith("#")) anchorsNeeded.set(target.slug, target.name);
  else warnings.push(`Lien « ${txt} » → ${target.url} : vérifier l'URL de la page dans WordPress`);
  return target.url;
}

function wrapLink(child, url, parentId, name) {
  const w = el("WrapperLink", { content: { content: { link: { type: "url", url } } } }, parentId, name);
  child._parentId = w.id;
  w.children.push(child);
  return w;
}

// Menu = cadre horizontal du header contenant au moins 2 textes, et seulement des textes ou des boutons
const isMenu = n => ZONE === "header" && n.type === "frame" && (n.layout ?? "horizontal") === "horizontal"
  && (n.children || []).filter(c => c.type === "text").length >= 2
  && (n.children || []).every(c => c.type === "text" || isButton(c));

async function convert(n, parent, parentId, isRoot = false) {
  if (n.enabled === false) return null;

  // Header / footer placé à l'intérieur d'une section (ex. en-tête posé sur le bandeau d'ouverture)
  if (!ZONE && !isRoot && n.type === "frame" && zoneName(n.name)) {
    ZONE = zoneName(n.name);
    try { return await convert(n, parent, parentId); } finally { ZONE = null; }
  }

  if (ZONE && !isRoot) {
    // Menu du header → MenuBuilder natif (MenuLink / MenuButton)
    if (isMenu(n)) {
      const m = el("MenuBuilder", {}, parentId, n.name);
      for (const c of n.children) {
        const label = c.type === "text" ? c : textNodes(c)[0];
        let url = linkFor(label);
        if (!url) { url = "#"; warnings.push(`Menu « ${label.content} » : lien à définir`); }
        const item = c.type === "text"
          ? el("MenuLink", { content: { content: { link: { type: "url", url }, text: label.content ?? "" } } }, m.id, c.name)
          : el("MenuButton", { content: { content: { text: label.content ?? "", link: { type: "url", url } } } }, m.id, c.name);
        m.children.push(item);
      }
      warnings.push(`Menu « ${n.name} » : typographie, couleurs et espacements du menu à régler dans Breakdance`);
      return m;
    }
    // Logo → lien vers l'accueil
    if (/logo/i.test(n.name || "") && !n._linked) {
      n._linked = true;
      const inner = await convert(n, parent, parentId);
      return inner && wrapLink(inner, "/", parentId, n.name);
    }
    // Réseaux sociaux → lien à renseigner
    if (n.type === "frame" && SOCIAL.test(n.name || "") && !n._linked) {
      n._linked = true;
      const inner = await convert(n, parent, parentId);
      warnings.push(`Lien ${n.name} : URL du profil à renseigner`);
      return inner && wrapLink(inner, "#", parentId, n.name);
    }
    // Texte → lien si on sait où il mène
    if (n.type === "text" && !n._linked && !/^(titre|title|heading)\b/i.test(n.name || "")) {
      if (LEGAL.test(n.content || "")) warnings.push(`« ${n.content} » : liens vers les pages légales à créer`);
      const url = linkFor(n);
      if (url) {
        n._linked = true;
        const inner = await convert(n, parent, parentId);
        return wrapLink(inner, url, parentId, n.name);
      }
    }
  }

  const css = [];
  const props = {};
  absCss(n, css);
  effectsCss(n, css);

  // Texte
  if (n.type === "text") {
    const tag = headingTag(n);
    const e = el(tag ? "Heading" : "Text", props, parentId, n.name);
    if (tag) deepSet(props, "content.content", { text: n.content ?? "", tags: tag });
    else { deepSet(props, "content.content.text", n.content ?? ""); deepSet(props, "settings.advanced.tag", n.textGrowth === "fixed-width" ? "p" : "span"); }
    if (n.href) css.push("cursor: pointer;");
    typography(props, n, css);
    for (const [k, v] of Object.entries(sizing(n, parent, css, "text"))) deepSet(props, k, v);
    finishCss(props, css);
    e.data.properties = props;
    return e;
  }

  // Icône
  if (n.type === "icon") {
    const svg = await iconSvg(n.library, n.icon);
    if (!svg) warnings.push(`Icône introuvable : ${n.library}/${n.icon} (${n.name})`);
    const e = el("Icon", props, parentId, n.name);
    if (svg) deepSet(props, "content.content.icon", { slug: `icon-${n.icon}.`, name: n.icon, svgCode: svg });
    const size = typeof n.width === "number" ? n.width : 24;
    deepSet(props, "design.icon.size", bp(px(size)));
    const f = fillsOf(n)[0];
    if (f) deepSet(props, "design.icon.color", color(typeof f === "string" ? f : f.color));
    finishCss(props, css);
    e.data.properties = props;
    return e;
  }

  // Bouton (frame avec fond/bordure + texte + icône éventuelle)
  if (!isRoot && isButton(n)) {
    const label = textNodes(n)[0];
    const hasFill = fillsOf(n).length > 0;
    const e = el("Button", props, parentId, n.name);
    deepSet(props, "content.content", { text: label.content ?? "", link: { type: "url", url: linkFor(label) || "#" } });
    deepSet(props, "design.button.style", hasFill ? "primary" : "secondary");
    if (hasFill) { const f = fillsOf(n)[0]; primaryButtons.push({ bg: typeof f === "string" ? f : f.color, color: textFill(label) }); }
    if (n.children.some(c => c.type === "icon")) warnings.push(`Bouton « ${label.content} » : l'icône n'est pas reprise, à régler dans Breakdance`);
    finishCss(props, css);
    e.data.properties = props;
    return e;
  }

  const leaf = !(n.children || []).length && ["frame", "rectangle"].includes(n.type);
  const solid = fillsOf(n).length === 1 && (typeof fillsOf(n)[0] === "string" || fillsOf(n)[0].type === "color");

  // Trait (rectangle fin et plein) → Divider solid
  // Seul le style est connu (export Breakdance réel) : couleur et épaisseur restent à régler dans Breakdance.
  if (!isRoot && leaf && solid && typeof n.height === "number" && n.height <= 4
      && (n.width === "fill_container" || (typeof n.width === "number" && n.width >= n.height * 6))) {
    const f = fillsOf(n)[0];
    const e = el("FancyDivider", props, parentId, n.name);
    deepSet(props, "settings.advanced.tag", "div");
    deepSet(props, "content.divider", { content: null });
    deepSet(props, "design.divider", { style: "solid" });
    if (n.width === "fill_container") css.push(parent && layoutOf(parent) === "horizontal" ? "flex: 1 1 0;" : "width: 100%;");
    else css.push(`width: ${numCss(n.width)};`, "flex-shrink: 0;");
    warnings.push(`Divider « ${n.name} » : couleur ${color(typeof f === "string" ? f : f.color)} et épaisseur ${n.height}px à régler dans Breakdance`);
    finishCss(props, css);
    e.data.properties = props;
    return e;
  }

  // Point (petite ellipse pleine) → Icon cercle (Font Awesome, comme dans Breakdance)
  if (!isRoot && n.type === "ellipse" && solid && n.stroke === undefined && typeof n.width === "number" && n.width <= 24) {
    const f = fillsOf(n)[0];
    const e = el("Icon", props, parentId, n.name);
    deepSet(props, "content.content.icon", {
      id: 490, slug: "icon-circle.", name: "circle", iconSetSlug: "FontAwesome 6 Free - Solid",
      svgCode: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512z"/></svg>',
    });
    deepSet(props, "design.icon.size", bp(px(n.width)));
    deepSet(props, "design.icon.color", color(typeof f === "string" ? f : f.color));
    finishCss(props, css);
    e.data.properties = props;
    return e;
  }

  // Cadre/rectangle sans enfant rempli d'une image → Image
  const imgFill = fillsOf(n).find(f => typeof f === "object" && f.type === "image" && f.url);
  if (!isRoot && leaf && imgFill) {
    const e = el("Image2", props, parentId, n.name);
    deepSet(props, "content.image", { from: "media_library", lazy_load: true, alt: "from_media_library", media: mediaFromUrl(imgFill.url) });
    for (const [k, v] of Object.entries(sizing(n, parent, css, "image"))) deepSet(props, k, v);
    if (n.width === "fill_container" && parent && layoutOf(parent) === "horizontal") deepSet(props, "design.image.width", bp({ number: 100, unit: "%", style: "100%" }));
    if (n.height === "fill_container") deepSet(props, "design.image.height", bp({ number: 100, unit: "%", style: "100%" }));
    deepSet(props, "design.image.object_fit", bp(imgFill.mode === "contain" ? "contain" : imgFill.mode === "stretch" ? "fill" : "cover"));
    const b = bordersObj(n);
    if (b?.radius) deepSet(props, "design.borders", { radius: b.radius });
    if (b?.border) borderCss(n, css);
    finishCss(props, css);
    e.data.properties = props;
    return e;
  }

  // Rectangle / ellipse / frame vide sans layout → Div décorative
  const kind = n.type === "frame" ? "frame" : n.type;
  if (!["frame", "rectangle", "ellipse", "group"].includes(kind)) {
    warnings.push(`Type non géré : ${n.type} (${n.name}) — ignoré`);
    return null;
  }

  const layout = n.type === "frame" ? layoutOf(n) : n.type === "group" ? "none" : null;
  const isSection = isRoot;
  const e = el(isSection ? "Section" : "Div", props, parentId, n.name);
  const grid = isSection ? null : gridOf(n, parent);

  // Layout
  if (grid) {
    const N = grid.cols;
    const perRow = { breakpoint_base: N };
    if (PAGE_WIDTH >= 1024) {           // maquette ordinateur : grille qui se replie sur tablette / mobile
      if (N > 2) perRow.breakpoint_tablet_portrait = 2;
      perRow.breakpoint_phone_landscape = 1;
    }
    deepSet(props, "design.layout_v2", {
      layout: "grid",
      g_items_per_row: perRow,
      ...(grid.gap ? { g_space_between_items: bp(num(grid.gap)) } : {}),
    });
    if ((grid.rowGap ?? 0) !== (grid.gap ?? 0)) warnings.push(`« ${n.name} » : grille avec espacement vertical (${grid.rowGap ?? 0}) ≠ horizontal (${grid.gap ?? 0}), Breakdance n'en garde qu'un (${grid.gap ?? 0})`);
  } else if (layout === "horizontal") {
    const hasFrameChildren = (n.children || []).filter(c => c.type === "frame" && !isButton(c)).length >= 2;
    deepSet(props, "design.layout_v2", {
      layout: "horizontal",
      ...(n.justifyContent && n.justifyContent !== "start" ? { h_align: bp(JUSTIFY[n.justifyContent]) } : {}),
      ...(n.alignItems ? { h_vertical_align: bp(ALIGN[n.alignItems]) } : { h_vertical_align: bp("flex-start") }),
      ...(n.gap ? { h_gap: bp(num(n.gap)) } : {}),
      ...(hasFrameChildren ? { h_vertical_at: "breakpoint_tablet_portrait" } : {}),
    });
    if (!hasFrameChildren && (n.children || []).length > 2) css.push("flex-wrap: wrap;");
  } else if (layout === "vertical") {
    deepSet(props, "design.layout_v2", {
      layout: "vertical",
      v_align: bp(n.alignItems ? ALIGN[n.alignItems] : "flex-start"),
      ...(n.justifyContent && n.justifyContent !== "start" ? { v_vertical_align: bp(JUSTIFY[n.justifyContent]) } : {}),
      ...(n.gap ? { v_gap: bp(num(n.gap)) } : {}),
    });
  } else if (layout === "none") {
    css.push("position: relative;");
  }

  // Padding
  const pad = sides(n.padding) ?? (isSection ? { top: 0, right: 0, bottom: 0, left: 0 } : null);
  if (isSection) {
    deepSet(props, "design.spacing.padding", bp(Object.fromEntries(["top", "right", "bottom", "left"].map(k => [k, num(pad[k] ?? 0)]))));
  } else if (pad) {
    const sp = spacingObj(pad);
    if (Object.keys(sp).length) {
      deepSet(props, "design.container.padding.padding", bp(sp));
    }
  }
  if (isSection) {
    // Section : contenu pleine largeur du conteneur, padding vertical géré au-dessus
    // Section : largeur via design.size (width = custom → container_width), cf. elements.json
    deepSet(props, "design.size.width", bp("custom"));
    deepSet(props, "design.size.container_width", bp(px(Math.max(320, PAGE_WIDTH - (pad ? (pad.left || 0) + (pad.right || 0) : 0)))));
    if (typeof n.height === "number") css.push(`min-height: ${n.height}px;`);
  }

  applyBackground(props, n);
  if (n.type === "ellipse") css.push("border-radius: 50%;");
  const b = bordersObj(n);
  if (b && !isSection) deepSet(props, "design.container.borders", b);
  if (b && isSection) { borderCss(n, css); if (b.radius) css.push(`border-radius: ${numCss(Array.isArray(n.cornerRadius) ? n.cornerRadius[0] : n.cornerRadius)};`); }
  if (n.clip) css.push("overflow: hidden;");

  if (!isSection) for (const [k, v] of Object.entries(sizing(n, parent, css, "div"))) deepSet(props, k, v);
  if (kind !== "frame" && typeof n.height === "number") deepSet(props, "design.container.min_height", bp(px(n.height)));

  // Enfants : position absolue → le parent devient référent
  const kids = n.children || [];
  if (kids.some(c => c.layoutPosition === "absolute") || layout === "none") {
    if (!css.includes("position: relative;")) css.push("position: relative;");
  }
  if (grid) {
    // Les rangées pen disparaissent : leurs cellules deviennent les enfants directs de la grille
    for (const c of grid.cells) {
      const ce = await convert(c, GRID_PARENT, e.id);
      if (ce) e.children.push(ce);
    }
  } else for (const c of kids) {
    if (layout === "none") c._absParent = true;
    const ce = await convert(c, n, e.id);
    if (ce) e.children.push(ce);
  }

  finishCss(props, css);
  e.data.properties = Object.keys(props).length ? props : null;
  return e;
}

// ---------- Global Settings Breakdance ----------
const mostCommon = arr => { const c = {}; for (const x of arr) if (x) c[x] = (c[x] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null; };
const allTexts = dump.pages.flatMap(p => p.sections.flatMap(textNodes));
FONTS = {
  heading: mostCommon(allTexts.filter(t => headingTag(t)).map(t => resolve(t.fontFamily))),
  body: mostCommon(allTexts.filter(t => !headingTag(t)).map(t => resolve(t.fontFamily))),
};
const textFill = t => { const f = fillsOf(t)[0]; return f && (typeof f === "string" ? f : f.color); };
const primaryButtons = []; // [{ bg, color }] relevés pendant la conversion

function globalSettings() {
  const colors = Object.entries(VARS).filter(([, v]) => v.type === "color")
    .map(([k]) => ({ cssVariableName: paletteName(k), label: k, value: varValue("$" + k) ?? null }));
  const settings = {
    typography: { heading_font: gfont(FONTS.heading), body_font: gfont(FONTS.body) },
    colors: { palette: { colors } },
  };
  const bodyColor = mostCommon(allTexts.filter(t => !headingTag(t)).map(textFill));
  if (bodyColor) settings.colors.text = color(bodyColor);
  const pageBg = dump.pages.map(p => p.fill).find(f => typeof f === "string");
  if (pageBg) settings.colors.background = color(pageBg);
  const bg = mostCommon(primaryButtons.map(b => b.bg)), fg = mostCommon(primaryButtons.map(b => b.color));
  if (bg) settings.buttons = { primary: { background: color(bg), ...(fg ? { typography: { color: bp(color(fg)) } } : {}) } };
  return { settings };
}

// ---------- main ----------
const slug = s => (s || "section").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const pad2 = n => String(n).padStart(2, "0");
const wrap = element => JSON.stringify({ source: SOURCE, element, colors: [], presets: [] });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const report = [];
const usedPageSlugs = new Set();
for (const page of dump.pages) {
  PAGE_WIDTH = page.width || 1440;
  nextId = 1000;
  let ps = slug(page.name);
  while (usedPageSlugs.has(ps)) ps += "-2";
  usedPageSlugs.add(ps);
  const pageDir = path.join(OUT, ps);
  fs.mkdirSync(pageDir, { recursive: true });
  const all = [];
  const zoneOf = node => zoneName(node.name);
  LINK_TARGETS = [
    ...page.sections.filter((s, i) => !zoneOf(s, i)).map(s => ({ name: s.name, slug: slugify(s.name), url: "#" + slugify(s.name) })),
    // « Plâtrerie & isolation — Ordinateur 1440 » → /platrerie-isolation/ (la variante d'écran n'est pas une page WordPress)
    ...dump.pages.map(p => slugify(pageTitle(p.name))).filter((sl, i, all) => sl !== slugify(pageTitle(page.name)) && all.indexOf(sl) === i)
      .map(sl => ({ name: sl, slug: sl, url: `/${sl}/` })),
  ];
  for (const [i, node] of page.sections.entries()) {
    ZONE = zoneOf(node, i);
    const section = await convert(node, null, 1, true);
    if (!section) continue;
    section._parentId = 1;
    all.push(section);
    fs.writeFileSync(path.join(pageDir, `${pad2(i + 1)}-${slug(node.name)}.json`), wrap(section));
  }
  // Ordre naturel : Breakdance colle les sections dans l'ordre du fichier (constaté sur une page sans sélection)
  if (all.length > 1) fs.writeFileSync(path.join(pageDir, "00-page-complete.json"), wrap(all));
  report.push(`  ${ps}/  (${all.length} section${all.length > 1 ? "s" : ""})`);
}

// ---------- médias ----------
const byName = new Map();
for (const [src, name] of media) byName.set(name, [...(byName.get(name) || []), src]);
const dupes = [...byName].filter(([, srcs]) => srcs.length > 1);
const mediaLines = [
  `# Médias utilisés par la maquette (${media.size})`,
  `# 1. Convertis chaque fichier en ${MEDIA_EXT || "format d'origine"} en GARDANT le même nom`,
  `# 2. Importe-les dans la médiathèque WordPress (le même mois, pour qu'ils soient dans le même dossier)`,
  `# 3. Renseigne "mediaUrl" dans pen2bd.config.json (ex. https://site.fr/wp-content/uploads/2026/11/) puis relance pen2bd`,
  `# URL actuelle : ${MEDIA_URL || "(non renseignée)"}`,
  "",
  ...[...media].map(([src, name]) => `${name}    ←  ${src}`),
];
if (dupes.length) mediaLines.push("", "# ⚠ Noms en double (WordPress ajoutera -1, -2…) : renomme ces fichiers dans la maquette", ...dupes.map(([n, s]) => `#   ${n} : ${s.join(" | ")}`));
fs.writeFileSync(path.join(OUT, "medias.txt"), mediaLines.join("\n") + "\n");

// ---------- résumé ----------
const rel = p => path.relative(process.cwd(), p) || ".";
console.log(`✔ Export de ${path.basename(penFile)} → ${rel(OUT)}/`);
console.log(`  global-settings.json  (Breakdance > Global Settings > Import Global Settings, une fois par site)`);
console.log(report.join("\n"));
console.log(`  medias.txt  (${media.size} image${media.size > 1 ? "s" : ""})`);
if (firstRun) console.log(`\n  ℹ Config créée : ${rel(CONFIG_FILE)}`);
if (media.size && !MEDIA_URL) console.log(`  ⚠ mediaUrl non renseignée dans pen2bd.config.json : les images ne s'afficheront pas après collage.`);
if (dupes.length) console.log(`  ⚠ ${dupes.length} nom(s) d'image en double, voir medias.txt`);
fs.writeFileSync(path.join(OUT, "global-settings.json"), JSON.stringify(globalSettings()));
for (const [sl, name] of anchorsNeeded) warnings.push(`Section « ${name} » : lui donner l'ID « ${sl} » (onglet Advanced) pour que les liens #${sl} fonctionnent`);
const uniq = [...new Set(warnings)];
if (uniq.length) {
  fs.writeFileSync(path.join(OUT, "a-verifier.txt"),
    "# Points à régler à la main dans Breakdance après collage\n" +
    "# (le script ne met que des réglages Breakdance connus ; le reste est listé ici)\n\n" + uniq.join("\n") + "\n");
  console.log(`  a-verifier.txt  (${uniq.length} point${uniq.length > 1 ? "s" : ""} à régler à la main)`);
}
