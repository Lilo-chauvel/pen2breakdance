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
let PAGE_WIDTH = 1440;

let nextId = 1000;

// ---------- helpers valeurs ----------
const bp = v => ({ breakpoint_base: v });
const px = n => ({ number: n, unit: "px", style: `${n}px` });
const custom = s => ({ number: s, unit: "custom", style: String(s) });
const varName = v => `--${PREFIX}-${v.slice(1)}`;
const isVar = v => typeof v === "string" && v.startsWith("$");
// valeur numérique pen (nombre ou $variable) -> unité Breakdance
const num = v => isVar(v) ? custom(`var(${varName(v)})`) : px(v);
const numCss = v => isVar(v) ? `var(${varName(v)})` : `${v}px`;

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
const color = v => isVar(v) ? `var(${varName(v)})` : hexToCss(v);

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

function gradientCss(f) {
  const deg = 180 - (f.rotation ?? 0); // pen : 0° = haut, CCW ; CSS : 0° = haut, CW, et la direction pen pointe vers la fin du dégradé
  const stops = (f.colors || []).map(c => `${color(c.color)} ${Math.round((isVar(c.position) ? 0 : c.position) * 100)}%`).join(", ");
  return f.gradientType === "radial" ? `radial-gradient(${stops})` : `linear-gradient(${deg}deg, ${stops})`;
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

function applyBackground(props, n, css, isSection = false) {
  for (const f of fillsOf(n)) {
    if (typeof f === "string" || f.type === "color") {
      deepSet(props, "design.background.color", color(typeof f === "string" ? f : f.color));
    } else if (f.type === "image" && f.url && isSection) {
      const m = mediaFromUrl(f.url);
      css.push(`background-image: url("${m.url}");`, `background-size: ${f.mode === "contain" ? "contain" : f.mode === "stretch" ? "100% 100%" : "cover"};`, "background-position: center;");
    } else if (f.type === "image" && f.url) {
      deepSet(props, "design.background.type", "image");
      deepSet(props, "design.background.image", bp(mediaFromUrl(f.url)));
      css.push(`background-size: ${f.mode === "contain" ? "contain" : f.mode === "stretch" ? "100% 100%" : "cover"};`, "background-position: center;");
    } else if (f.type === "gradient") {
      css.push(`background-image: ${gradientCss(f)};`);
    }
  }
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
  if (t.fontFamily) css.push(`font-family: ${isVar(t.fontFamily) ? `var(${varName(t.fontFamily)})` : `"${t.fontFamily}", sans-serif`};`);
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
  && n.children.some(c => c.type === "text") && n.children.every(c => c.type === "text" || c.type === "icon")
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

async function convert(n, parent, parentId, isRoot = false) {
  if (n.enabled === false) return null;
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
    deepSet(props, "content.content", { text: label.content ?? "", link: { type: "url", url: "#" } });
    deepSet(props, "design.button.style", hasFill ? "primary" : "secondary");
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

  // Layout
  if (layout === "horizontal") {
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
    deepSet(props, "design.container.width", bp(px(Math.max(320, PAGE_WIDTH - (pad ? (pad.left || 0) + (pad.right || 0) : 0)))));
    if (typeof n.height === "number") css.push(`min-height: ${n.height}px;`);
  }

  applyBackground(props, n, css, isSection);
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
  for (const c of kids) {
    if (layout === "none") c._absParent = true;
    const ce = await convert(c, n, e.id);
    if (ce) e.children.push(ce);
  }

  finishCss(props, css);
  e.data.properties = Object.keys(props).length ? props : null;
  return e;
}

// ---------- CSS global (variables) ----------
function globalCss() {
  const lines = [];
  for (const [k, v] of Object.entries(VARS)) {
    const val = Array.isArray(v.value) ? v.value[0].value : v.value;
    let out = val;
    if (v.type === "color") out = hexToCss(val);
    else if (v.type === "number") out = `${val}px`;
    else if (v.type === "string") out = `"${val}", sans-serif`;
    else continue;
    lines.push(`  --${PREFIX}-${k}: ${out};`);
  }
  return `/* Variables de la maquette pen.dev\n   À coller une fois par site : Breakdance > Global Settings > Code > Custom CSS */\n:root {\n${lines.join("\n")}\n}\n`;
}

// ---------- main ----------
const slug = s => (s || "section").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const pad2 = n => String(n).padStart(2, "0");
const wrap = element => JSON.stringify({ source: SOURCE, element, colors: [], presets: [] });

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "variables.css"), globalCss());

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
  for (const [i, node] of page.sections.entries()) {
    const section = await convert(node, null, 1, true);
    if (!section) continue;
    section._parentId = 1;
    all.push(section);
    fs.writeFileSync(path.join(pageDir, `${pad2(i + 1)}-${slug(node.name)}.json`), wrap(section));
  }
  // Breakdance insère chaque élément d'une liste juste après la sélection : on inverse pour garder l'ordre
  if (all.length > 1) fs.writeFileSync(path.join(pageDir, "00-page-complete.json"), wrap([...all].reverse()));
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
console.log(`  variables.css  (à coller une fois dans Global Settings > Code > Custom CSS)`);
console.log(report.join("\n"));
console.log(`  medias.txt  (${media.size} image${media.size > 1 ? "s" : ""})`);
if (firstRun) console.log(`\n  ℹ Config créée : ${rel(CONFIG_FILE)} (préfixe des variables : --${PREFIX}-…)`);
if (media.size && !MEDIA_URL) console.log(`  ⚠ mediaUrl non renseignée dans pen2bd.config.json : les images ne s'afficheront pas après collage.`);
if (dupes.length) console.log(`  ⚠ ${dupes.length} nom(s) d'image en double, voir medias.txt`);
const uniq = [...new Set(warnings)];
if (uniq.length) {
  fs.writeFileSync(path.join(OUT, "a-verifier.txt"),
    "# Points à régler à la main dans Breakdance après collage\n" +
    "# (le script ne met que des réglages Breakdance connus ; le reste est listé ici)\n\n" + uniq.join("\n") + "\n");
  console.log(`  a-verifier.txt  (${uniq.length} point${uniq.length > 1 ? "s" : ""} à régler à la main)`);
}
