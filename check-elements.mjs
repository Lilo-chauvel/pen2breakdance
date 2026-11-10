#!/usr/bin/env node
// Vérifie un export pen2breakdance contre elements.json (définitions Breakdance extraites de l'éditeur).
// Usage : node check-elements.mjs <fichier.json | dossier> [elements.json]
// Contrôle : type d'élément connu, chemin de chaque propriété présent dans les contrôles,
// valeur autorisée pour les listes (dropdown / button_bar), clés de breakpoint valides.
import fs from "node:fs";
import path from "node:path";

const [target, defsFile = new URL("./elements.json", import.meta.url)] = process.argv.slice(2);
if (!target) { console.error("Usage : node check-elements.mjs <fichier.json | dossier> [elements.json]"); process.exit(2); }

const defs = new Map(JSON.parse(fs.readFileSync(defsFile, "utf8")).elements.map(e => [e.slug, e]));
const BREAKPOINTS = /^breakpoint_(base|tablet_landscape|tablet_portrait|phone_landscape|phone_portrait)$/;
const ENUM_TYPES = new Set(["dropdown", "button_bar"]);
// Propriétés gérées par Breakdance hors des contrôles de l'élément
const GLOBAL_PATHS = [/^meta(\.|$)/, /^settings\.advanced(\.|$)/];

const files = fs.statSync(target).isDirectory()
  ? fs.readdirSync(target, { recursive: true }).filter(f => f.endsWith(".json")).map(f => path.join(target, f))
  : [target];

const issues = new Map(); // message -> nb d'occurrences
const report = msg => issues.set(msg, (issues.get(msg) || 0) + 1);

function controlTree(def) {
  const root = { children: [] };
  for (const [key, top] of [["content", "contentSections"], ["design", "designSections"], ["settings", "settingsSections"]])
    root.children.push({ slug: key, options: { type: "section" }, children: def.controls?.[top] || [] });
  return root;
}

function checkEnum(ctrl, value, where) {
  const items = ctrl.options?.items;
  if (!ENUM_TYPES.has(ctrl.options?.type) || !Array.isArray(items) || typeof value !== "string") return;
  if (!items.some(i => i.value === value)) report(`${where} : valeur « ${value} » hors liste (${items.map(i => i.value).join(", ")})`);
}

function checkValue(ctrl, value, where) {
  if (ctrl.enableMediaQueries && value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (!BREAKPOINTS.test(k) && !k.endsWith("_hover")) report(`${where} : clé de breakpoint inconnue « ${k} »`);
      else checkEnum(ctrl, v, where);
    }
  } else checkEnum(ctrl, value, where);
}

function walk(ctrl, props, pathSoFar, type) {
  for (const [key, value] of Object.entries(props)) {
    const p = pathSoFar ? `${pathSoFar}.${key}` : key;
    if (GLOBAL_PATHS.some(r => r.test(p))) continue;
    const name = key.endsWith("_hover") ? key.slice(0, -6) : key;
    const child = (ctrl.children || []).find(c => c.slug === name);
    if (!child) { report(`${type.split("\\").pop()} : propriété inconnue ${p}`); continue; }
    const isSection = child.children?.length && ["section", "popout"].includes(child.options?.type);
    if (isSection && value && typeof value === "object" && !Array.isArray(value)) walk(child, value, p, type);
    else checkValue(child, value, `${type.split("\\").pop()} ${p}`);
  }
}

function visit(node) {
  const type = node.data?.type;
  if (type) {
    const def = defs.get(type);
    if (!def) report(`type d'élément inconnu : ${type}`);
    else if (node.data.properties) walk(controlTree(def), node.data.properties, "", type);
  }
  (node.children || []).forEach(visit);
}

let nodes = 0;
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f, "utf8"));
  const roots = Array.isArray(data.element) ? data.element : data.element ? [data.element] : [];
  const count = n => 1 + (n.children || []).reduce((s, c) => s + count(c), 0);
  roots.forEach(r => { nodes += count(r); visit(r); });
}

console.log(`${files.length} fichier(s), ${nodes} élément(s) vérifié(s) contre ${defs.size} définitions.`);
if (!issues.size) { console.log("Aucun écart."); process.exit(0); }
for (const [msg, n] of [...issues].sort()) console.log(`✗ ${msg}${n > 1 ? `  (×${n})` : ""}`);
process.exit(1);
