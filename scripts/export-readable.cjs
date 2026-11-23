#!/usr/bin/env node
/**
 * Экспорт программ МК-61 в читаемый TXT.
 *
 * Формат тот же, что мы приняли для Б3-34:
 *   заголовок, источник, «Перед пуском», «Ожидаемый результат»,
 *   затем шаги: адрес — код — команда (подпись обязательна),
 *   в конце коды строкой и регистры после пуска.
 *
 * Данные берутся из двух мест:
 *   - листинг games/... (адреса и мнемоники);
 *   - JSON генератора ожиданий (коды, экран, регистры) — tmp/imports/expectations.json
 *
 * Запуск:
 *   node scripts/export-readable.cjs --in tmp/imports/expectations.json --out tmp/imports/readable
 *   node scripts/export-readable.cjs --merge          # только сборники на раздел
 *   node scripts/export-readable.cjs --single         # только отдельные файлы
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const inFile = String(arg('in', 'tmp/imports/expectations.json'));
const outDir = String(arg('out', 'tmp/imports/readable'));
const onlyMerge = Boolean(arg('merge', false));
const onlySingle = Boolean(arg('single', false));
const verbose = Boolean(arg('verbose', false));

function log(...a) {
  if (verbose) console.log(...a);
}

/* ---------- утилиты ---------- */

function resolveRepoFile(rel) {
  const candidates = [
    path.join(ROOT, rel),
    path.join(ROOT, 'games', rel),
    path.join(ROOT, rel.replace(/^games\//, '')),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Адрес в листинге — 0x00..0x99 и 0xA0..0xA4; на МК-61 это шаги 0..104. */
function addrToIndex(addr) {
  const n = parseInt(addr, 16);
  if (Number.isNaN(n)) return -1;
  if (n >= 0xa0) return n - 0xa0 + 100;
  return n;
}

function pad2(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

function idxToAddr(i) {
  return i >= 100 ? pad2(0xa0 + (i - 100)) : pad2(i);
}

/** Читает листинг «адрес  команда» и возвращает шаги. */
function readListing(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const steps = [];
  for (const raw of lines) {
    const line = raw.replace(/\t/g, ' ').trimEnd();
    if (!line.trim()) continue;
    const m = line.match(/^([0-9A-Fa-f]{2})\s+(.+)$/);
    if (!m) continue;
    const addr = m[1].toUpperCase();
    let rest = m[2].trim();
    let comment = '';
    const cut = rest.indexOf('—');
    if (cut !== -1) {
      comment = rest.slice(cut + 1).trim();
      rest = rest.slice(0, cut).trim();
    }
    steps.push({ addr, index: addrToIndex(addr), command: rest, comment });
  }
  steps.sort((a, b) => a.index - b.index);
  return steps;
}

function normalizeList(json) {
  if (Array.isArray(json)) return json;
  for (const key of ['programs', 'items', 'results', 'entries']) {
    if (Array.isArray(json[key])) return json[key];
  }
  return [];
}

function pick(obj, keys, fallback) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return fallback;
}

function slugOf(entry) {
  const p = String(pick(entry, ['path', 'program', 'file'], ''));
  const base = p.split('/').pop() || 'program';
  return base.replace(/\.txt$/i, '').replace(/[^0-9A-Za-z._-]+/g, '-');
}

function codesOf(result) {
  const raw = pick(result, ['codes', 'programCodes', 'memory'], null);
  if (!Array.isArray(raw)) return null;
  return raw.map((v) => Number(v) & 0xff);
}

function regsOf(result) {
  const r = pick(result, ['registers', 'regs', 'state'], null);
  if (!r || typeof r !== 'object') return null;
  return r;
}

function fmtRegs(regs) {
  if (!regs) return [];
  const out = [];
  const stackOrder = ['X', 'Y', 'Z', 'T', 'X1'];
  const stack = stackOrder
    .filter((k) => regs[k] !== undefined)
    .map((k) => `${k}=${regs[k]}`);
  if (stack.length) out.push('  стек: ' + stack.join('  '));
  const r = regs.R || regs.r || null;
  if (Array.isArray(r) && r.length) {
    const items = r.map((v, i) => `R${i.toString(16).toUpperCase()}=${v}`);
    for (let i = 0; i < items.length; i += 5) {
      out.push('  ' + items.slice(i, i + 5).join('  '));
    }
  }
  return out;
}

/* ---------- сборка одного файла ---------- */

function buildText(entry) {
  const section = String(pick(entry, ['section', 'group'], ''));
  const title = String(pick(entry, ['title', 'name'], slugOf(entry)));
  const author = pick(entry, ['author', 'real_name'], '');
  const source = pick(entry, ['source', 'source_url', 'sourceUrl'], '');
  const series = pick(entry, ['series', 'collection'], '');
  const relPath = String(pick(entry, ['path', 'program', 'file'], ''));
  const setup = pick(entry, ['setup', 'input', 'before'], '');
  const result = pick(entry, ['result', 'after', 'run'], entry);
  const diagnostics = pick(entry, ['diagnostics', 'warnings'], []);

  const display = pick(result, ['display', 'screen', 'displayText'], null);
  const stopped = pick(result, ['stopped', 'halted'], null);
  const pc = pick(result, ['pc', 'programCounter'], null);

  const file = resolveRepoFile(relPath);
  const steps = file ? readListing(file) : [];
  const codes = codesOf(result);

  const L = [];
  L.push(`МК-61 · ${title}`);
  const meta = [];
  if (section) meta.push(`раздел: ${section}`);
  if (series) meta.push(`серия: ${series}`);
  if (author) meta.push(`автор: ${author}`);
  if (meta.length) L.push(meta.join(' · '));
  if (source) L.push(`Источник: ${source}`);
  if (relPath) L.push(`Файл: ${relPath}`);
  L.push('');

  L.push(setup ? `Перед пуском: ${setup}` : 'Перед пуском: без подготовки');
  if (display !== null && display !== undefined && String(display).trim() !== '') {
    L.push(`Ожидаемый результат: экран «${display}»`);
  } else {
    L.push('Ожидаемый результат: экран не снят');
  }
  if (pc !== null && pc !== undefined) {
    L.push(`Остановка: PC = ${idxToAddr(Number(pc))}`);
  }
  if (stopped === false) {
    L.push('Внимание: эталон не остановился сам — программа интерактивная,');
    L.push('          ожидание снято с предела кадров, а не с С/П.');
  }
  L.push('');

  if (steps.length) {
    L.push('Адрес  Код  Команда');
    for (const s of steps) {
      const code = codes && codes[s.index] !== undefined ? pad2(codes[s.index]) : '--';
      const tail = s.comment ? `   — ${s.comment}` : '';
      L.push(`${s.addr}     ${code}   ${s.command}${tail}`);
    }
  } else {
    L.push('Листинг не найден — шаги не распечатаны.');
  }
  L.push('');

  if (codes) {
    L.push('Коды (hex): ' + codes.map((c) => pad2(c)).join(' '));
    L.push('Коды (dec): ' + codes.join(' '));
    L.push('');
  }

  const regs = fmtRegs(regsOf(result));
  if (regs.length) {
    L.push('Регистры после пуска:');
    L.push(...regs);
  }

  if (Array.isArray(diagnostics) && diagnostics.length) {
    L.push('');
    L.push('Предупреждения парсера:');
    for (const d of diagnostics) {
      L.push('  ' + (typeof d === 'string' ? d : JSON.stringify(d)));
    }
  }

  return { text: L.join('\n') + '\n', section, slug: slugOf(entry), title };
}

/* ---------- сборники ---------- */

function buildMerge(items, section) {
  const L = [];
  L.push(`Сборник программ МК-61 · ${section}`);
  L.push(`Программ: ${items.length}`);
  L.push('');
  L.push('Оглавление:');
  items.forEach((it, i) => {
    L.push(`  ${i + 1}. ${it.title} — ${it.slug}.txt`);
  });
  L.push('');
  for (const it of items) {
    L.push('');
    L.push('='.repeat(60));
    L.push('');
    L.push(it.text.trimEnd());
    L.push('');
  }
  return L.join('\n') + '\n';
}

/* ---------- main ---------- */

function main() {
  if (!fs.existsSync(inFile)) {
    console.error(`Нет файла ожиданий: ${inFile}`);
    console.error('Сначала запустите scripts/generate-game-expectations.cjs');
    process.exit(1);
  }

  const json = JSON.parse(fs.readFileSync(inFile, 'utf8'));
  const entries = normalizeList(json);
  if (!entries.length) {
    console.error('В JSON нет программ.');
    process.exit(1);
  }

  const bySection = new Map();
  let writtenFiles = 0;

  for (const entry of entries) {
    let built;
    try {
      built = buildText(entry);
    } catch (e) {
      console.error(`Ошибка на ${slugOf(entry)}: ${e.message}`);
      continue;
    }
    const section = built.section || 'other';
    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push(built);

    if (!onlyMerge) {
      const dir = path.join(outDir, section);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${built.slug}.txt`), built.text, 'utf8');
      writtenFiles++;
    }
  }

  if (!onlySingle) {
    let merged = 0;
    for (const [section, items] of bySection) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, `${section}.txt`), buildMerge(items, section), 'utf8');
      merged++;
    }
    log(`Сборников: ${merged}`);
  }

  log(`Отдельных файлов: ${writtenFiles}`);
  console.log(`Готово: ${entries.length} программ, разделов ${bySection.size}, в ${outDir}`);
}

main();
