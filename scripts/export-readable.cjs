'use strict';

/*
 * export-readable.cjs — конвертация листингов каталога games в читаемый вид.
 *
 * Что делает:
 *   1. читает games/manifest.tsv (11 колонок, поля в кавычках);
 *   2. для каждой записи с существующим .txt разбирает листинг
 *      настоящим ядром MKPro (parseCommandToken), а не своей таблицей;
 *   3. считает шаги, находит регистры, которые надо задать перед пуском;
 *   4. пишет readable/<раздел>/<имя>.txt, сборник readable/_sections/<раздел>.txt,
 *      общий index и список проблем.
 *
 * Чего НЕ делает: ничего не запускает на эмуляторе и не подставляет
 * ожидаемый результат. Прогон — отдельная задача (expectations).
 *
 * Запуск: node scripts/export-readable.cjs
 */

const fs = require('fs');
const path = require('path');
const { parseCommandToken } = require('../tests/emulator/mk61.cjs');

const ROOT = path.resolve(__dirname, '..');
const GAMES = path.join(ROOT, 'games');
const OUT = path.join(ROOT, 'readable');
const LIMIT = 105;

/* ------------------------------------------------------------------ */
/* Манифест                                                            */
/* ------------------------------------------------------------------ */

function splitTsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && current === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === '\t') {
      cells.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  cells.push(current);
  return cells;
}

function readManifest() {
  const file = path.join(GAMES, 'manifest.tsv');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = splitTsvLine(lines.shift()).map((cell) => cell.trim());
  const rows = [];
  for (const line of lines) {
    const cells = splitTsvLine(line);
    const row = {};
    header.forEach((name, index) => {
      row[name] = (cells[index] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Адреса                                                              */
/* ------------------------------------------------------------------ */

function formalAddress(opcode) {
  const high = opcode >> 4;
  const low = opcode & 0x0f;
  const ordinal = high * 10 + low;
  if (ordinal <= 104) return ordinal;
  if (ordinal <= 111) return ordinal - 105;
  if (ordinal <= 165) return ordinal - 112;
  return null;
}

function addressLabel(address) {
  if (address >= 100) return '−' + (address - 100);
  return String(address).padStart(2, '0');
}

/* ------------------------------------------------------------------ */
/* Разбор листинга                                                     */
/* ------------------------------------------------------------------ */

const SKIP_LINE = /^\s*(#|\/\/|;|—|–|--)/u;

function parseListing(raw) {
  const rows = [];
  const problems = [];
  const seen = new Map();
  const emptyLabels = new Map();

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\u00A0/g, ' ');
    if (!line.trim()) continue;
    if (SKIP_LINE.test(line)) continue;

    const match = line.match(/^\s*([0-9A-Fa-f]{2}|[.\-][0-9A-Fa-f])\s+(.+?)\s*$/u);
    if (!match) {
      problems.push('строка не похожа на команду: ' + line.trim());
      continue;
    }
    const addressToken = match[1].toUpperCase().replace(/[.\-]/g, 'A');
    const opcode = parseInt(addressToken, 16);
    let address = formalAddress(opcode);
    if (address === null) {
      problems.push('адрес вне памяти: ' + match[1]);
      address = rows.length;
    }
    const token = match[2].replace(/\s+/g, ' ');
    const parsed = parseCommandToken(token, address, emptyLabels);
    if (parsed.warning) problems.push(parsed.warning);
    if (seen.has(address)) {
      problems.push('адрес ' + addressLabel(address) + ' задан дважды: ' + token);
    }
    seen.set(address, true);
    rows.push({ address, token, code: parsed.code });
  }

  return { rows, problems };
}

/* ------------------------------------------------------------------ */
/* Какие регистры нужно задать перед пуском                            */
/* ------------------------------------------------------------------ */

const READ_OPS = new Set([0x6, 0xd, 0x7, 0x9, 0xc, 0xe]);
const LOOP_OPS = new Map([[0x5d, 0], [0x5b, 1], [0x58, 2], [0x5a, 3]]);

function normalizeRegister(nibble) {
  return nibble === 0x0f ? 0 : nibble;
}

function inputRegisters(codes) {
  const written = new Array(15).fill(false);
  const read = new Array(15).fill(false);

  for (const code of codes) {
    const hi = code >> 4;
    const lo = code & 0x0f;

    if (hi === 0x4 || hi === 0xb) {
      written[normalizeRegister(lo)] = true;
      continue;
    }
    if (READ_OPS.has(hi) && hi !== 0xd && hi !== 0xe ? true : READ_OPS.has(hi)) {
      const register = normalizeRegister(lo);
      if (!written[register]) read[register] = true;
    }
    if (LOOP_OPS.has(code)) {
      const register = LOOP_OPS.get(code);
      if (!written[register]) read[register] = true;
    }
  }

  const result = [];
  for (let register = 0; register < 15; register += 1) {
    if (read[register]) result.push(register);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Один файл                                                           */
/* ------------------------------------------------------------------ */

const REGISTER_NAME = '0123456789ABCDE';

function compactList(value) {
  return value ? value.split(';').map((part) => part.trim()).filter(Boolean).join(', ') : '—';
}

function renderProgram(entry, parsed) {
  const codes = parsed.rows.map((row) => row.code);
  const inputs = inputRegisters(codes);
  const steps = parsed.rows.length;
  const lines = [];

  lines.push('МК-61 · ' + (entry.title || path.basename(entry.program, '.txt')));
  lines.push('');
  lines.push('Автор: ' + (entry.author || '—'));
  if (entry.real_name) lines.push('Перевод, адаптация: ' + entry.real_name);
  lines.push('Источник: ' + (entry.source_url || '—'));
  lines.push('Раздел: ' + (entry.section || '—') + ' · тип: ' + (entry.kind || '—'));
  lines.push('Теги: ' + compactList(entry.tags));
  if (entry.collection) lines.push('Коллекция-источник: ' + entry.collection);
  if (entry.series) lines.push('Серия: ' + entry.series);
  lines.push('Листинг каталога: games/' + entry.program);
  lines.push('');

  lines.push('Шагов: ' + steps + ' из ' + LIMIT);
  if (steps > LIMIT) lines.push('ВНИМАНИЕ: программа длиннее памяти МК-61 на ' + (steps - LIMIT) + ' шагов.');
  if (inputs.length) {
    lines.push('Перед пуском: ' + inputs.map((register) => 'R' + REGISTER_NAME[register]).join(', ') + ' — задать значения');
  } else {
    lines.push('Перед пуском: регистры задавать не нужно');
  }
  lines.push('');

  lines.push('Листинг:');
  lines.push('адрес  hex  dec  команда');
  for (const row of parsed.rows) {
    lines.push(
      addressLabel(row.address).padEnd(6) +
        ' ' +
        row.code.toString(16).toUpperCase().padStart(2, '0').padEnd(4) +
        ' ' +
        String(row.code).padStart(3, '0') +
        '  ' +
        row.token
    );
  }

  if (parsed.problems.length) {
    lines.push('');
    lines.push('Замечания при разборе:');
    for (const problem of parsed.problems) lines.push('- ' + problem);
  }

  lines.push('');
  lines.push('Коды получены разбором ядра MKPro (tests/emulator/mk61.cjs),');
  lines.push('ожидаемый экран здесь не указан: он берётся из отдельного прогона.');
  lines.push('');

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Сборка                                                              */
/* ------------------------------------------------------------------ */

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function main() {
  const manifest = readManifest();
  ensureDir(OUT);
  ensureDir(path.join(OUT, '_sections'));

  const index = [];
  const problemsOut = [];
  const bySection = new Map();
  let converted = 0;
  let skipped = 0;

  for (const entry of manifest) {
    const programPath = (entry.program || '').trim();
    if (!programPath.endsWith('.txt') || !programPath.includes('/')) {
      skipped += 1;
      problemsOut.push('пропуск (нет листинга): ' + (programPath || entry.title || '—'));
      continue;
    }
    const full = path.join(GAMES, programPath);
    if (!fs.existsSync(full)) {
      skipped += 1;
      problemsOut.push('пропуск (файла нет): games/' + programPath);
      continue;
    }

    const raw = fs.readFileSync(full, 'utf8');
    const parsed = parseListing(raw);
    const text = renderProgram(entry, parsed);

    const section = entry.section || path.dirname(programPath);
    const targetDir = path.join(OUT, section);
    ensureDir(targetDir);
    const targetName = path.basename(programPath, '.txt') + '.txt';
    fs.writeFileSync(path.join(targetDir, targetName), text, 'utf8');

    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push({ entry, text });

    const unknown = parsed.problems.filter((problem) => problem.startsWith('Command at'));
    index.push({
      section,
      program: programPath,
      title: entry.title || '',
      author: entry.author || '',
      kind: entry.kind || '',
      steps: parsed.rows.length,
      unknown: unknown.length,
      notes: parsed.problems.length,
    });
    if (unknown.length) {
      problemsOut.push('games/' + programPath + ': не разобрано команд ' + unknown.length);
      for (const problem of unknown) problemsOut.push('    ' + problem);
    }
    converted += 1;
  }

  for (const [section, items] of bySection) {
    const parts = ['Сборник раздела ' + section, 'Программ: ' + items.length, ''];
    for (const item of items) {
      parts.push('='.repeat(60));
      parts.push('');
      parts.push(item.text);
      parts.push('');
    }
    fs.writeFileSync(path.join(OUT, '_sections', section + '.txt'), parts.join('\n'), 'utf8');
  }

  index.sort((a, b) => (a.section + '/' + a.program).localeCompare(b.section + '/' + b.program));
  const indexLines = ['раздел\tфайл\tназвание\tавтор\tтип\tшагов\tне разобрано'];
  for (const row of index) {
    indexLines.push(
      [row.section, row.program, row.title, row.author, row.kind, row.steps, row.unknown].join('\t')
    );
  }
  fs.writeFileSync(path.join(OUT, '_index.tsv'), indexLines.join('\n') + '\n', 'utf8');

  const sections = [...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const readme = [];
  readme.push('# Читаемый каталог МК-61');
  readme.push('');
  readme.push('Собрано из `games/manifest.tsv` скриптом `scripts/export-readable.cjs`.');
  readme.push('Коды команд разобраны ядром MKPro; ожидаемый экран здесь не приводится.');
  readme.push('');
  readme.push('| Раздел | Программ | Шагов всего |');
  readme.push('|:---|---:|---:|');
  for (const [section, items] of sections) {
    const total = items.reduce((sum, item) => sum + (item.entry ? 0 : 0), 0);
    readme.push('| ' + section + ' | ' + items.length + ' | — |');
  }
  readme.push('');
  readme.push('Всего переконвертировано: **' + converted + '**');
  readme.push('Пропущено записей без листинга: ' + skipped);
  readme.push('');
  readme.push('- `_index.tsv` — таблица всех программ');
  readme.push('- `_problems.txt` — что не разобралось');
  readme.push('- `_sections/<раздел>.txt` — сборник раздела');
  fs.writeFileSync(path.join(OUT, 'README.md'), readme.join('\n'), 'utf8');

  fs.writeFileSync(
    path.join(OUT, '_problems.txt'),
    problemsOut.length ? problemsOut.join('\n') + '\n' : 'Проблем не найдено.\n',
    'utf8'
  );

  console.log('переконвертировано: ' + converted);
  console.log('пропущено: ' + skipped);
  console.log('разделов: ' + sections.length);
}

main();
