#!/usr/bin/env node
// Envoie un transcript (JSON produit par .claude/skills/transcription/scripts/transcribe.py) dans le CRM,
// rattaché à un enregistrement : node tools/push-transcript.mjs <fileId> <transcript.json> [--base https://…] [--token prénom.mac]
// Le jeton : CRM → Extension → jeton, ou variable OUTREACH_TOKEN.
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const [fileId, jsonPath] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const base = opt('--base', process.env.OUTREACH_BASE || 'https://missioncrea.clippingatlas.com');
const token = opt('--token', process.env.OUTREACH_TOKEN);
if (!fileId || !jsonPath || !token) { console.error('usage : push-transcript.mjs <fileId> <transcript.json> [--base url] [--token prénom.mac]'); process.exit(1); }
const tr = JSON.parse(readFileSync(jsonPath, 'utf-8'));
const body = { model: tr.model, language: tr.language, segments: tr.segments, text: tr.segments.map((s) => s.text).join('\n') };
const r = await fetch(`${base}/api/files/${fileId}/transcript`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
console.log(r.status, await r.text());
