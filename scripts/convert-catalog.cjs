#!/usr/bin/env node
'use strict';

/**
 * Конвертация ВСЕГО каталога games/ в читаемый вид.
 *
 * В отличие от export-readable.cjs этот скрипт НЕ ждёт прогона: коды команд
 * он берёт у самого ядра (loadProgram + readProgramCodes), а не из JSON
 * ожиданий. Поэтому работает всегда, даже если эталон на программе завис.
 *
 * Результат:
 *   readable/<раздел>/<программа>.txt   — по одному файлу
 *   readable/<раздел>.txt               — сборник раздела
 *   readable/README.md                  — оглавление и статистика
 *
 * Формат файла — как договорились для 34-й модели:
 *   заголовок, источник, «Перед пуском», шаги «адрес — код — команда»,
 *   коды строкой в hex и dec.
 *
 * Запуск:
 *   node scripts/convert-catalog.cjs
 *   node scripts/convert-catalog.cjs --section utilities --verbose
 *   node scripts/convert-catalog.cjs --out readable --limit 5
 */

const fs = require('fs');
const path = require('path');

const { MK61, parseProgramText } = require('../tests/emulator/mk61.cjs');
const { readManifest, resolveListing } = require('./generate-game-expectations.cjs');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    out: path.join(ROOT, 'readable'),
    section: null,
    limit: Infinity,
    offset: 0,
    angle: 'deg',
    extended: true,
    verbose: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Не задано значение для ${key}`);
      return value;
    };
    switch (key) {
      case '--out': args.out = path.resolve(ROOT, next()); break;
      case '--section': args.section = next().toLowerCase(); break;
      case '--limit': args.limit = Number(next()); break;
      case '--offset': args.offset = Number(next()); break;
      case '--angle': args.angle = next(); break;
      case '--basic': args.extended = false; break;
      case '--verbose': args.verbose = true; break;
      default: throw new Error(`Неизвестный аргумент: ${key}`);
    }
  }
  return args;
}

function pad2(value) {
  return (Number(value) & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

function addrToIndex(addr) {
  const n = parseInt(addr, 16);
  if (Number.isNaN(n)) return -1;
  if (n >= 0xa0) return n - 0xa0 + 100;
  return n;
}

function idxToAddr(index) {
  return index >= 100 ? pad2(0xa0 + (index - 100)) : pad2(index);
}

/**
 * Разбор листинга: строки вида «00<TAB>хП0».
 * Всё, что не начинается с адреса, уходит в «прочее» — оттуда же берём
 * подготовку регистров, если она записана в файле.
 */
function readListing(text) {
  const steps = [];
  const setup = [];
  const notes = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, ' ').trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
      notes.push(trimmed.replace(/^[#;]\s*/, ''));
      continue;
    }

    const match = trimmed.match(/^([0-9A-Fa-f]{2})[\s:]+(.+)$/);
    if (match) {
      const addr = match[1].toUpperCase();
      let command = match[2].trim();
      let comment = '';
      const cut = command.indexOf('—');
      if (cut !== -1) {
        comment = command.slice(cut + 1).trim();
        command = command.slice(0, cut).trim();
      }
      steps.push({ addr, index: addrToIndex(addr), command, comment });
      continue;
    }

    if (/^(R[0-9A-E]|X)\s*=/i.test(trimmed)) setup.push(trimmed);
    else notes.push(trimmed);
  }

  steps.sort((a, b) => a.index - b.index);
  return { steps, setup, notes };
}

function codesOf(text, args) {
  const machine = new MK61({ extended: args.extended, angleMode: args.angle });
  const loaded = machine.loadProgram(text);
  const codes = machine.readProgramCodes(machine.commandLimit());
  return { codes, diagnostics: loaded.diagnostics || [] };
}

function buildEntry(row, listingText, args) {
  const { steps, setup, notes } = readListing(listingText);
  const { codes, diagnostics } = codesOf(listingText, args);
  const parsed = parseProgramText(listingText);
  const allDiagnostics = [...(parsed.diagnostics || []), ...diagnostics];

  const title = row.title || row.program.replace(/\.txt$/i, '');
  const lines = [];

  lines.push(`МК-61 · ${title}`);
  const meta = [];
  if (row.section) meta.push(`раздел: ${row.section}`);
  if (row.series) meta.push(`серия: ${row.series}`);
  if (row.collection) meta.push(`сборник: ${row.collection}`);
  if (row.author) meta.push(`автор: ${row.author}`);
  if (meta.length) lines.push(meta.join(' · '));
  if (row.source_url) lines.push(`Источник: ${row.source_url}`);
  if (row.description) lines.push(`Описание: ${row.description}`);
  lines.push(`Файл: ${row.program}`);
  lines.push('');

  lines.push(
    setup.length
      ? `Перед пуском: ${setup.join('; ')}`
      : 'Перед пуском: в листинге не указано',
  );
  lines.push('Ожидаемый результат: не снят (прогон эталона не выполнялся)');
  lines.push('');

  lines.push('Адрес  Код  Команда');
  for (const step of steps) {
    const code = codes[step.index] !== undefined ? pad2(codes[step.index]) : '--';
    const tail = step.comment ? `   — ${step.comment}` : '';
    lines.push(`${step.addr}     ${code}   ${step.command}${tail}`);
  }
  lines.push('');

  const used = codes.slice(0, Math.max(0, steps.length));
  if (used.length) {
    lines.push('Коды (hex): ' + used.map(pad2).join(' '));
    lines.push('Коды (dec): ' + used.map((code) => Number(code) & 0xff).join(' '));
    lines.push('');
  }

  if (notes.length) {
    lines.push('Примечания листинга:');
    for (const note of notes) lines.push('  ' + note);
    lines.push('');
  }

  if (allDiagnostics.length) {
    lines.push('Не распознано при разборе:');
    for (const item of allDiagnostics) {
      lines.push('  ' + (typeof item === 'string' ? item : JSON.stringify(item)));
    }
    lines.push('');
  }

  return {
    text: lines.join('\n') + '\n',
    section: row.section || 'other',
    slug: path.basename(row.program, '.txt'),
    title,
    steps: steps.length,
    codes: used.length,
    diagnostics: allDiagnostics.length,
  };
}

function buildMerge(section, items) {
  const out = [];
  out.push(`Сборник программ МК-61 · ${section}`);
  out.push(`Программ: ${items.length}`);
  out.push('');
  out.push('Оглавление:');
  items.forEach((item, i) => {
    out.push(`  ${String(i + 1).padStart(3, ' ')}. ${item.title} — ${item.slug}.txt`);
  });
  out.push('');
  for (const item of items) {
    out.push('');
    out.push('='.repeat(64));
    out.push('');
    out.push(item.text.trimEnd());
    out.push('');
  }
  return out.join('\n') + '\n';
}

function buildIndex(sections, stats) {
  const out = [];
  out.push('# Читаемые программы МК-61');
  out.push('');
  out.push('Собрано автоматически из `games/` по путям из `games/manifest.tsv`.');
  out.push('Коды команд получены от эталонного ядра (`tests/emulator/mk61.cjs`),');
  out.push('а не вычислены вручную.');
  out.push('');
  out.push(`- программ: **${stats.programs}**`);
  out.push(`- разделов: **${sections.length}**`);
  out.push(`- шагов расписано: **${stats.steps}**`);
  out.push(`- программ с нераспознанными командами: **${stats.withDiagnostics}**`);
  out.push(`- обновлено: ${stats.date}`);
  out.push('');
  out.push('Ожидаемый результат в файлах не указан намеренно: он появится');
  out.push('после эталонного прогона. Выдумывать его нельзя.');
  out.push('');
  out.push('## Разделы');
  out.push('');
  out.push('| Раздел | Программ | Сборник |');
  out.push('|:---|---:|:---|');
  for (const section of sections) {
    out.push(`| ${section.name} | ${section.items.length} | [${section.name}.txt](${section.name}.txt) |`);
  }
  out.push('');
  return out.join('\n') + '\n';
}

function main() {
  const args = parseArgs(process.argv);
  let rows = readManifest().filter((row) => row.program && /\.txt$/i.test(row.program));

  if (args.section) rows = rows.filter((row) => row.section.toLowerCase() === args.section);
  rows = rows.slice(args.offset, args.offset + args.limit);

  const bySection = new Map();
  const skipped = [];
  let steps = 0;
  let withDiagnostics = 0;
  let programs = 0;

  for (const row of rows) {
    const listing = resolveListing(row.program);
    if (!listing) {
      skipped.push({ id: row.program, reason: 'листинг не найден' });
      continue;
    }
    const text = fs.readFileSync(listing, 'utf8');
    if (!text.trim()) {
      skipped.push({ id: row.program, reason: 'пустой файл' });
      continue;
    }

    try {
      const entry = buildEntry(row, text, args);
      programs++;
      steps += entry.steps;
      if (entry.diagnostics > 0) withDiagnostics++;

      if (!bySection.has(entry.section)) bySection.set(entry.section, []);
      bySection.get(entry.section).push(entry);

      const dir = path.join(args.out, entry.section);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${entry.slug}.txt`), entry.text, 'utf8');

      if (args.verbose) process.stdout.write(`${row.program}: ${entry.steps} шагов\n`);
    } catch (error) {
      skipped.push({ id: row.program, reason: String(error.message || error) });
    }
  }

  const sections = [...bySection.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => a.name.localeCompare(b.name));

  fs.mkdirSync(args.out, { recursive: true });
  for (const section of sections) {
    fs.writeFileSync(path.join(args.out, `${section.name}.txt`), buildMerge(section.name, section.items), 'utf8');
  }

  fs.writeFileSync(
    path.join(args.out, 'README.md'),
    buildIndex(sections, {
      programs,
      steps,
      withDiagnostics,
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
    }),
    'utf8',
  );

  process.stdout.write(
    `Готово: ${programs} программ, разделов ${sections.length}, шагов ${steps}. ` +
    `С нераспознанными командами: ${withDiagnostics}. Пропущено: ${skipped.length}.\n` +
    `Каталог: ${path.relative(ROOT, args.out)}\n`,
  );
  for (const item of skipped.slice(0, 20)) {
    process.stdout.write(`  пропуск ${item.id}: ${item.reason}\n`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { readListing, buildEntry, buildMerge };
