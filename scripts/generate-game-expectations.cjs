#!/usr/bin/env node
'use strict';

/**
 * Генератор ожиданий для тестов ядра.
 *
 * Читает каталог games/manifest.tsv, берёт листинги программ, загружает их
 * в ЭТАЛОННЫЙ эмулятор (tests/emulator/mk61.cjs — модель ИК1302/1303/1306),
 * прогоняет до устойчивого состояния и складывает результат в JSON.
 *
 * Никакой фильтрации команд нет: пишутся все коды, какие есть в листинге,
 * включая недокументированные. Extended = true (105 шагов).
 * Экран снимается целиком, с символами L, С, Г, Е — это не «мусор»,
 * а честное состояние индикатора, которое потом сверяет наше ядро.
 *
 * Запуск:
 *   node scripts/generate-game-expectations.cjs --section utilities
 *   node scripts/generate-game-expectations.cjs --section utilities --limit 10
 *   node scripts/generate-game-expectations.cjs --program games/utilities/sum-natural-formula.txt
 *   node scripts/generate-game-expectations.cjs --section games --start "В/О,С/П" --out tmp/imports/all.json
 *
 * Пути берутся ТОЛЬКО из манифеста: собирать путь из имени файла нельзя.
 */

const fs = require('fs');
const path = require('path');

const { MK61, parseProgramText } = require('../tests/emulator/mk61.cjs');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'games', 'manifest.tsv');
const DEFAULT_OUT = path.join(ROOT, 'tmp', 'imports', 'expectations.json');

const COLUMNS = [
  'program', 'description', 'title', 'author', 'real_name',
  'source_url', 'kind', 'section', 'tags', 'collection', 'series',
];

const REGISTERS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E'];
const STACK = ['X', 'Y', 'Z', 'T', 'X1'];

function parseArgs(argv) {
  const args = {
    section: null,
    series: null,
    kind: null,
    program: null,
    limit: Infinity,
    offset: 0,
    out: DEFAULT_OUT,
    start: 'В/О,С/П',
    angle: 'rad',
    maxFrames: 4000,
    stableFrames: 6,
    extended: true,
    inputs: null,
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
      case '--section': args.section = next().toLowerCase(); break;
      case '--series': args.series = next().toLowerCase(); break;
      case '--kind': args.kind = next().toLowerCase(); break;
      case '--program': args.program = next(); break;
      case '--limit': args.limit = Number(next()); break;
      case '--offset': args.offset = Number(next()); break;
      case '--out': args.out = path.resolve(ROOT, next()); break;
      case '--start': args.start = next(); break;
      case '--angle': args.angle = next(); break;
      case '--max-frames': args.maxFrames = Number(next()); break;
      case '--stable-frames': args.stableFrames = Number(next()); break;
      case '--inputs': args.inputs = next(); break;
      case '--basic': args.extended = false; break;
      case '--verbose': args.verbose = true; break;
      default: throw new Error(`Неизвестный аргумент: ${key}`);
    }
  }
  return args;
}

/** Читает манифест. Колонки берутся по шапке, а не по номеру. */
function readManifest(file = MANIFEST) {
  if (!fs.existsSync(file)) throw new Error(`Манифест не найден: ${file}`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length === 0) return [];

  const header = lines[0].split('\t').map((cell) => cell.trim());
  const knownHeader = header.length >= 3 && COLUMNS.some((column) => header.includes(column));
  const index = {};
  COLUMNS.forEach((column, position) => {
    index[column] = knownHeader ? header.indexOf(column) : position;
  });
  const body = knownHeader ? lines.slice(1) : lines;

  return body.map((line) => {
    const cells = line.split('\t');
    const row = {};
    for (const column of COLUMNS) {
      const position = index[column];
      row[column] = position >= 0 && position < cells.length ? cells[position].trim() : '';
    }
    return row;
  });
}

/** Путь листинга — как записан в манифесте, без домыслов. */
function resolveListing(program) {
  const raw = program.replace(/\\/g, '/');
  const candidates = [
    path.join(ROOT, raw),
    path.join(ROOT, 'games', raw),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseStartSequence(start) {
  const keys = String(start)
    .split(/[,;]+/)
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.length > 0 ? keys : ['С/П'];
}

function snapshotRegisters(machine) {
  const values = {};
  for (const register of REGISTERS) {
    try {
      values[`R${register}`] = machine.readRegister(register, { syncPhase: false });
    } catch (error) {
      values[`R${register}`] = `!${error.message}`;
    }
  }
  for (const register of STACK) {
    try {
      values[register] = machine.readRegister(register, { syncPhase: false });
    } catch (error) {
      values[register] = `!${error.message}`;
    }
  }
  return values;
}

function runCase(row, listingText, args) {
  const parsed = parseProgramText(listingText);
  const machine = new MK61({ extended: args.extended, angleMode: args.angle });

  const loaded = machine.loadProgram(listingText);

  const startKeys = parseStartSequence(args.start);
  machine.pressSequence(startKeys);

  const run = machine.runUntilStable({
    maxFrames: args.maxFrames,
    stableFrames: args.stableFrames,
  });

  const display = machine.displayText();
  const pc = machine.programCounter();
  const registers = snapshotRegisters(machine);
  const codes = machine.readProgramCodes(machine.commandLimit());

  const diagnostics = [...parsed.diagnostics, ...(loaded.diagnostics || [])];

  return {
    id: row.program,
    title: row.title,
    author: row.author,
    kind: row.kind,
    section: row.section,
    series: row.series,
    tags: row.tags,
    source: row.source_url,
    start: startKeys,
    stopped: run.stopped,
    frames: run.frames,
    display,
    pc,
    codes,
    codeCount: codes.length,
    registers,
    diagnostics,
  };
}

function main() {
  const args = parseArgs(process.argv);
  let rows = readManifest();

  if (args.program) rows = rows.filter((row) => row.program === args.program);
  if (args.section) rows = rows.filter((row) => row.section.toLowerCase() === args.section);
  if (args.series) rows = rows.filter((row) => row.series.toLowerCase() === args.series);
  if (args.kind) rows = rows.filter((row) => row.kind.toLowerCase() === args.kind);

  rows = rows.slice(args.offset, args.offset + args.limit);

  const cases = [];
  const skipped = [];
  const failed = [];

  for (const row of rows) {
    const listing = resolveListing(row.program);
    if (!listing) {
      skipped.push({ id: row.program, reason: 'листинг не найден по пути из манифеста' });
      continue;
    }
    const text = fs.readFileSync(listing, 'utf8');
    if (!text.trim()) {
      skipped.push({ id: row.program, reason: 'пустой файл' });
      continue;
    }
    try {
      const result = runCase(row, text, args);
      cases.push(result);
      if (args.verbose) {
        const tail = result.stopped ? `стоп за ${result.frames} кадров` : `НЕ остановилась за ${result.frames}`;
        process.stdout.write(`${row.program}: «${result.display}» (${tail})\n`);
      }
    } catch (error) {
      failed.push({ id: row.program, error: String(error.message || error) });
    }
  }

  const payload = {
    format: 'mk-expectations',
    version: 1,
    generated: new Date().toISOString(),
    emulator: {
      name: 'MK61 (tests/emulator/mk61.cjs)',
      model: 'ИК1302 / ИК1303 / ИК1306',
      extended: args.extended,
      angleMode: args.angle,
      commandLimit: args.extended ? 105 : 98,
    },
    run: {
      start: parseStartSequence(args.start),
      maxFrames: args.maxFrames,
      stableFrames: args.stableFrames,
    },
    filter: {
      section: args.section,
      series: args.series,
      kind: args.kind,
      program: args.program,
      limit: Number.isFinite(args.limit) ? args.limit : null,
      offset: args.offset,
    },
    totals: {
      selected: rows.length,
      cases: cases.length,
      stopped: cases.filter((item) => item.stopped).length,
      skipped: skipped.length,
      failed: failed.length,
      withDiagnostics: cases.filter((item) => item.diagnostics.length > 0).length,
      unrecognizedCodes: cases.filter((item) => item.diagnostics.length > 0).length,
    },
    cases,
    skipped,
    failed,
  };

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const { totals } = payload;
  process.stdout.write(
    `Готово: ${totals.cases} из ${totals.selected} программ, ` +
    `остановились ${totals.stopped}, пропущено ${totals.skipped}, ошибок ${totals.failed}. ` +
    `С предупреждениями разбора: ${totals.withDiagnostics}.\n` +
    `Файл: ${path.relative(ROOT, args.out)}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Ошибка: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { readManifest, resolveListing, runCase, parseStartSequence };
