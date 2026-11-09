// Lecture d'un document pen.dev via le serveur MCP local fourni avec l'application (aucune IA impliquée).
// L'application pen.dev doit être ouverte (le .pen sur disque n'est qu'un pointeur, le contenu est géré par l'app).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const exists = f => { try { return fs.existsSync(f); } catch { return false; } };
const mcpIn = dir => { try { return fs.readdirSync(dir).filter(f => f.startsWith("mcp-server-")).map(f => path.join(dir, f)); } catch { return []; } };
const OUT_DIR = ["resources", "app.asar.unpacked", "out"];

function findServer() {
  // 1. variable d'environnement
  if (process.env.PEN_MCP_BIN && exists(process.env.PEN_MCP_BIN)) return process.env.PEN_MCP_BIN;

  // 2. configuration Claude Code (si pen.dev y a été branché)
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    const cmd = cfg.mcpServers?.pencil?.command;
    if (cmd && exists(cmd)) return cmd;
  } catch {}

  // 3. emplacements d'installation connus
  const dirs = [];
  if (process.platform === "linux") {
    for (const d of fs.readdirSync("/tmp").filter(d => d.startsWith(".mount_Pen"))) dirs.push(path.join("/tmp", d, ...OUT_DIR)); // AppImage en cours
    for (const base of ["/opt/pen.dev", "/opt/Pen", "/usr/lib/pen", path.join(os.homedir(), ".local/share/pen")]) dirs.push(path.join(base, ...OUT_DIR));
  } else if (process.platform === "darwin") {
    for (const app of ["/Applications/Pen.app", path.join(os.homedir(), "Applications/Pen.app"), "/Applications/pen.dev.app", "/Applications/Pencil.app"])
      dirs.push(path.join(app, "Contents", ...OUT_DIR));
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    for (const name of ["Pen", "pen", "pen.dev", "Pencil"]) {
      dirs.push(path.join(local, "Programs", name, ...OUT_DIR));
      dirs.push(path.join(process.env.ProgramFiles || "C:\\Program Files", name, ...OUT_DIR));
    }
  }
  for (const d of dirs) { const found = mcpIn(d)[0]; if (found) return found; }

  throw new Error(
    "Serveur MCP de pen.dev introuvable. Vérifie que pen.dev est ouvert, sinon indique son chemin :\n" +
    "  PEN_MCP_BIN=/chemin/vers/mcp-server-xxx pen2bd");
}

export async function withPen(fn, timeoutMs = 30000) {
  const proc = spawn(findServer(), ["--app", "desktop", "--agent", "pen2breakdance"], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = "", id = 0;
  const pending = {};
  proc.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; } } catch {}
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    const t = setTimeout(() => reject(new Error("pen.dev ne répond pas")), timeoutMs);
    pending[i] = m => { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result); };
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n");
  });
  const tool = async (name, args) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = (r.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
    if (r.isError) throw new Error(text);
    return text;
  };
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pen2breakdance", version: "2.0" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn(tool);
  } finally {
    proc.kill();
  }
}

// Exporte tout le document : { variables, pages: [{ name, width, sections: [...] }] }
// - un cadre racine vertical avec plusieurs enfants = une page, chaque enfant = une section
// - tout autre cadre racine = une page d'une seule section
const SNIPPET = `
const pages=[];
for(const r of Get(document,(n,c)=>{c.skipChildren();return n.type==="frame"&&!n.reusable?{id:n.id,w:c.bounds.width}:undefined})){
  const n=Get(r.id);
  const multi=n.layout==="vertical"&&(n.children||[]).length>1;
  pages.push({name:n.name,width:r.w,fill:n.fill,sections:multi?n.children:[n]});
}
Print("@@DUMP@@"+JSON.stringify({variables:GetVariables().variables||{},pages}));`;

export async function readDocument(file, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await withPen(async tool => {
        const out = await tool("execute", { filePath: file, description: "Export vers Breakdance", input: SNIPPET });
        const m = /@@DUMP@@(.*)/.exec(out);
        if (!m) throw new Error("Lecture pen.dev échouée :\n" + out.slice(0, 500));
        return JSON.parse(m[1]);
      });
    } catch (e) {
      if (i >= attempts || !/ne répond pas/.test(e.message)) throw e;
    }
  }
}
