'use strict';

/*
 * export-readable.cjs — конвертация листингов каталога games в читаемый вид.
 *
 * Что делает:
 *   1. читает games/manifest.tsv (11 колонок, поля в кавычках);
 *   2. отделяет листинг от карточки игры и делит файл на отдельные программы
 *      (scripts/readable-sections.cjs), описание сохраняет секциями;
 *   3. для каждой программы разбирает листинг настоящим ядром MKPro
 *      (parseCommandToken), а не своей таблицей;
 *   4. если ядро не узнало подпись — пробует нормализованный вариант
 *      (чужую нотацию приводит к той, что ждёт ядро);
 *   5. отличает примечание к листингу (кириллический текст) от ошибки;
 *   6. ничего не угадывает: всё неоднозначное уходит в _problems.txt
 *      с указанием причины;
 *   7. пишет readable/<раздел>/<имя>.txt, сборник readable/_sections/<раздел>.txt,
 *      сборники серий readable/_series/<серия>.txt, общий index и список проблем.
 *
 * Чего НЕ делает: ничего не запускает на эмуляторе и не подставляет
 * ожидаемый результат. Прогон — отдельная задача (expectations).
 *
 * Запуск: node scripts/export-readable.cjs
 */

const fs = require('fs');
const path = require('path');
const { parseCommandToken } = require('../tests/emulator/mk61.cjs');
const { splitPrograms } = require('./readable-sections.cjs');

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
/* Нормализация чужой нотации                                          */
/* ------------------------------------------------------------------ */

/*
 * Ядро (normalizeMnemonic) уже приводит регистр букв, минусы, знаки
 * операций и пробелы. Здесь добавляется только то, чего там нет:
 * обратный слэш, маркеры списка вместо умножения, надстрочные знаки,
 * дефис внутри записи регистра, запись обратных функций со степенью,
 * неполные стоп и возврат, фигурные и квадратные скобки K-функций,
 * цикл без пробела (FLO), шаг влево/вправо, буква О вместо нуля
 * в номере регистра.
 *
 * Всё, что не удалось привести однозначно, остаётся как было
 * и попадает в проблемы — подстановок «по смыслу» здесь нет.
 * В частности НЕ подставляются: Fx>0 (в таблице ядра есть только
 * x≥0 и x≠0), К1/К2 (K-функции записаны номером клавиши, таблицы
 * «клавиша → функция» в листинге нет), П5(6) (две редакции),
 * А1 в колонке команды (адрес, а не команда).
 */
function normalizeListingToken(raw) {
  let s = String(raw).replace(/[\u00A0\u2007\u202F]/g, ' ').trim();
  if (!s) return s;

  /* все виды тире и минуса — к обычному дефису.
     \u1400-\u167F — канадский слоговой блок: там сидит «ᐨ» из Ftgᐨ¹ */
  s = s.replace(/[\u2212\u1400-\u167F\u2010-\u2015\uFE63\uFF0D\u02D7]/g, '-');

  /* обратный слэш: «С\П» — частая запись стопа в тетрадях */
  s = s.replace(/\\/g, '/');

  /* маркеры перечисления вместо умножения */
  s = s.replace(/[\u2022\u00B7\u2219\u22C5\u25E6]/g, '*');

  /* степень: надстрочные символы и хвост «^» без операнда */
  s = s.replace(/[\u02E3\u1D61]/g, '^');
  s = s.replace(/\^\s*$/, '^X');

  /* обратные тригонометрические: Ftg^-1 -> arctg и так далее */
  s = s.replace(/^F\s*(sin|cos|tg)\s*\^?\s*-?\s*1$/i, (whole, fn) => {
    const name = fn.toLowerCase();
    if (name === 'sin') return 'arcsin';
    if (name === 'cos') return 'arccos';
    return 'arctg';
  });

  /* «Fx^10» и «F10ˣ» — это одна и та же команда 10 в степени X */
  s = s.replace(/^F\s*X\s*\^\s*10$/i, '10^X');
  s = s.replace(/^F\s*10\s*\^\s*X$/i, '10^X');

  /* запись регистра через дефис и стрелку: х-Пd, П-Х9, КП-хA, Kx-ПA */
  s = s.replace(/^(К|K)\s*(X|Х|х|x)\s*-?\s*(>|→)?\s*П\s*([0-9A-EА-Яа-яa-e])$/u, 'KXП$4');
  s = s.replace(/^(К|K)\s*П\s*-?\s*(>|→)?\s*(X|Х|х|x)\s*([0-9A-EА-Яа-яa-e])$/u, 'KПX$4');
  s = s.replace(/^(X|Х|х|x)\s*-?\s*(>|→)?\s*П\s*([0-9A-EА-Яа-яa-e])\s*(\([^)]*\))?$/u, 'XП$3');
  s = s.replace(/^П\s*-?\s*(>|→)?\s*(X|Х|х|x)\s*([0-9A-EА-Яа-яa-e])\s*(\([^)]*\))?$/u, 'ПX$3');

  /* стрелки внутри склеенных записей K-функций: К°->′ и К°<-′" */
  s = s.replace(/-\s*>/g, '→').replace(/<\s*-/g, '←');

  /* шаг влево/вправо: «ШГ->», «ШГ <-» — ядро ждёт ШГ→ и ШГ← */
  s = s.replace(/^ШГ\s*-\s*>\s*$/u, 'ШГ→');
  s = s.replace(/^ШГ\s*<\s*-?\s*$/u, 'ШГ←');

  /* цикл записан без пробела: FLO, FL3 — ядро ждёт FL0…FL3 */
  s = s.replace(/^F\s*L\s*([0-3])$/iu, 'FL$1');

  /* скобки без операнда */
  s = s.replace(/^(К|K)\s*\{\s*\}$/u, 'K{X}');
  s = s.replace(/^(К|K)\s*\[\s*\]$/u, 'K[X]');
  s = s.replace(/^\{\s*\}$/u, '{X}');
  s = s.replace(/^\[\s*\]$/u, '[X]');

  /* совмещённое сравнение: >/=0 и <=0.
     ВНИМАНИЕ: это только снятие лишней косой черты в записи,
     смысл сравнения не меняется и не додумывается. */
  s = s.replace(/([<>])\s*\/\s*=/g, '$1=');

  /* неполные стоп и возврат */
  s = s.replace(/^(С|C)\s*\/?\s*(П|N)$/u, 'С/П');
  s = s.replace(/^(В|B)\s*\/?\s*(О|O)$/u, 'В/О');

  /* квадратный корень словами */
  s = s.replace(/^F?\s*sqrt$/i, 'F√');
  s = s.replace(/^F\s*F\s*√$/u, 'F√');

  /* буква О вместо нуля в номере регистра: ПхО -> Пх0, ППхО -> ППх0.
     Замена только в последней позиции двухсимвольной записи регистра:
     иначе «О» в других местах (например, в слове) пострадает. */
  s = s.replace(/^((?:П|X|К|K)?[XxХх])\s*[ОO]$/u, (whole, head) => head + '0');

  return s;
}

/*
 * Примечание к листингу, а не команда: кириллический текст без цифр
 * и без символов, из которых состоят команды. Такие строки в каталоге
 * описывают, что делает программа, и в проблемах им не место.
 */
function looksLikeNote(token) {
  const text = String(token).trim();
  if (!/[А-Яа-яЁё]{4,}/u.test(text)) return false;
  if (/[0-9]/u.test(text)) return false;
  return /^[А-Яа-яЁё\s.,:;!?'"«»()\-—–]+$/u.test(text);
}

/* ------------------------------------------------------------------ */
/* Разбор листинга                                                     */
/* ------------------------------------------------------------------ */

const SKIP_LINE = /^\s*(#|\/\/|;|—|–|--)/u;
const ADDRESS_CELL = /^\s*([0-9A-Fa-f]{2}|[.\-][0-9A-Fa-f]|[АA][0-4])\s+(.+?)\s*$/u;

function entriesOf(raw) {
  const entries = [];
  const badLines = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\u00A0/g, ' ');
    if (!line.trim()) continue;
    if (SKIP_LINE.test(line)) continue;
    const match = line.match(ADDRESS_CELL);
    if (!match) {
      badLines.push('строка не похожа на команду: ' + line.trim());
      continue;
    }
    entries.push({ addressToken: match[1], token: match[2].replace(/\s+/g, ' ') });
  }
  return { entries, badLines };
}

/*
 * Файл записан десятичными кодами: заметная доля токенов — числа 100+.
 * Порог снижен с 0.6/0.3 до 0.15/0.05: в реальных файлах (harvest, mustang,
 * naval-battle, cooperative-cafe) числа занимают 15–35 %, остальное —
 * мнемоники, и прежний порог не срабатывал ни разу.
 */
function isDecimalListing(entries) {
  if (entries.length < 5) return false;
  const numeric = entries.filter((entry) => /^\d{1,3}$/.test(entry.token.trim()));
  const large = numeric.filter((entry) => Number(entry.token.trim()) >= 100);
  return numeric.length / entries.length > 0.15 && large.length / entries.length > 0.05;
}

function resolveToken(rawToken, address, labels, decimal) {
  const direct = parseCommandToken(rawToken, address, labels);
  if (!direct.warning) return { code: direct.code, via: 'как есть' };

  const normalized = normalizeListingToken(rawToken);
  if (normalized && normalized !== rawToken) {
    const again = parseCommandToken(normalized, address, labels);
    if (!again.warning) return { code: again.code, via: 'нормализация', fixed: normalized };
  }

  if (decimal) {
    const text = rawToken.trim();
    if (/^\d{1,3}$/.test(text)) {
      const code = Number(text);
      if (code >= 0 && code <= 255) return { code, via: 'десят. код' };
    }
  }

  if (looksLikeNote(rawToken)) return { code: 0, via: 'примечание' };

  return { code: null, warning: direct.warning || ('не разобрано: ' + rawToken) };
}

function parseListing(raw) {
  const { entries, badLines } = entriesOf(raw);
  const decimal = isDecimalListing(entries);
  const rows = [];
  const problems = badLines.slice();
  const notes = [];
  const fixed = [];
  const seen = new Map();
  const labels = new Map();

  for (const entry of entries) {
    const addressToken = entry.addressToken.toUpperCase().replace(/[.\-А]/g, 'A');
    const opcode = parseInt(addressToken, 16);
    let address = formalAddress(opcode);
    if (address === null) {
      problems.push('адрес вне памяти: ' + entry.addressToken);
      address = rows.length;
    }

    const resolved = resolveToken(entry.token, address, labels, decimal);

    if (resolved.via === 'примечание') {
      notes.push(addressLabel(address) + ': ' + entry.token);
      continue;
    }
    if (resolved.code === null) {
      problems.push('не разобрано на ' + addressLabel(address) + ': ' + entry.token);
      rows.push({ address, token: entry.token, code: 0 });
      continue;
    }
    if (resolved.via === 'нормализация') {
      fixed.push(entry.token + ' → ' + resolved.fixed);
    }

    if (seen.has(address)) {
      problems.push('адрес ' + addressLabel(address) + ' задан дважды: ' + entry.token);
    }
    seen.set(address, true);
    rows.push({ address, token: entry.token, code: resolved.code });
  }

  rows.sort((a, b) => a.address - b.address);
  return { rows, problems, notes, fixed, decimal };
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
    if (READ_OPS.has(hi)) {
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
/* Риск: почему запись нельзя считать проверенной                      */
/* ------------------------------------------------------------------ */

function riskOf(entry, programPath) {
  const marks = [];
  const haystack = [programPath, entry.collection, entry.source_url, entry.tags].join(' ').toLowerCase();
  if (/-c3000/.test(haystack) || /3000/.test(entry.collection || '')) marks.push('c3000');
  if (/brp4|брп-4/.test(haystack)) marks.push('brp4');
  if (/notebook|тетрад|manuscript/.test(haystack)) marks.push('manuscript');
  if (/modernized|codex/.test(haystack)) marks.push('modernized');
  return marks.join(';');
}

function riskListOf(entry, programPath) {
  const marks = riskOf(entry, programPath).split(';').filter(Boolean);
  const list = [];
  if (marks.includes('c3000')) list.push('другой калькулятор (C3000), не МК-61');
  if (marks.includes('brp4')) list.push('модуль расширения БРП-4, коды из PDF и бинарника');
  if (marks.includes('manuscript')) list.push('листинг перепечатан с фото, часть кодов могла не сохраниться');
  if (marks.includes('modernized')) list.push('современная переработка, не оригинал 1980-х');
  return list;
}

/* ------------------------------------------------------------------ */
/* Один файл                                                           */
/* ------------------------------------------------------------------ */

const REGISTER_NAME = '0123456789ABCDE';

function compactList(value) {
  return value ? value.split(';').map((part) => part.trim()).filter(Boolean).join(', ') : '—';
}

/* Длинные карточки не режем: описание из источника — ценная часть каталога. */
function pushBlock(lines, title, text) {
  if (!text || !text.trim()) return;
  lines.push('');
  lines.push(title);
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) lines.push(line);
}

/* Один блок программы: шаги, что задать перед пуском, листинг, замечания. */
function programBlock(item, index, total) {
  const parsed = item.parsed;
  const codes = parsed.rows.map((row) => row.code);
  const inputs = inputRegisters(codes);
  const out = [];

  if (total > 1) {
    out.push(item.title ? 'Программа ' + index + ': ' + item.title : 'Программа ' + index);
    if (item.note && item.note !== item.title) {
      out.push('');
      for (const line of item.note.split('\n')) out.push(line);
    }
    out.push('');
  }

  out.push('Шагов: ' + parsed.rows.length + ' из ' + LIMIT);
  if (parsed.rows.length > LIMIT) {
    out.push('ВНИМАНИЕ: программа длиннее памяти МК-61 на ' + (parsed.rows.length - LIMIT) + ' шагов.');
  }
  if (inputs.length) {
    out.push('Перед пуском: ' + inputs.map((register) => 'R' + REGISTER_NAME[register]).join(', ') + ' — задать значения');
  } else {
    out.push('Перед пуском: регистры задавать не нужно');
  }
  if (parsed.decimal) out.push('Формат листинга: десятичные коды (не подписи команд).');
  out.push('');

  out.push('Листинг:');
  out.push('адрес  hex  dec  команда');
  for (const row of parsed.rows) {
    out.push(
      addressLabel(row.address).padEnd(6) +
        ' ' +
        row.code.toString(16).toUpperCase().padStart(2, '0').padEnd(4) +
        ' ' +
        String(row.code).padStart(3, '0') +
        '  ' +
        row.token
    );
  }

  if (parsed.notes.length) {
    out.push('');
    out.push('Примечания из листинга:');
    for (const note of parsed.notes) out.push('- ' + note);
  }
  if (parsed.fixed.length) {
    out.push('');
    out.push('Подписи, приведённые к формату ядра:');
    for (const one of parsed.fixed) out.push('- ' + one);
  }
  if (item.warn && item.warn.length) {
    out.push('');
    out.push('Структура файла:');
    for (const one of item.warn) out.push('- ' + one);
  }
  if (parsed.problems.length) {
    out.push('');
    out.push('Замечания при разборе:');
    for (const problem of parsed.problems) out.push('- ' + problem);
  }

  return out;
}

function renderProgram(entry, parsedList, programPath, sections) {
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
  lines.push('Листинг каталога: games/' + programPath);
  if (parsedList.length > 1) lines.push('Программ в файле: ' + parsedList.length);

  const risks = riskListOf(entry, programPath);
  if (risks.length) {
    lines.push('');
    lines.push('Осторожно:');
    for (const risk of risks) lines.push('- ' + risk);
  }
  lines.push('');

  parsedList.forEach((item, index) => {
    if (index) {
      lines.push('');
      lines.push('='.repeat(60));
      lines.push('');
    }
    lines.push(...programBlock(item, index + 1, parsedList.length));
  });

  /* Карточка из источника: то, что в файле стоит до и после листинга. */
  if (sections) {
    pushBlock(lines, 'Карточка из источника (до листинга):', sections.before);
    pushBlock(lines, 'Описание и примечания источника (после листинга):', sections.after);
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
  ensureDir(path.join(OUT, '_series'));

  const index = [];
  const problemsOut = [];
  const bySection = new Map();
  const bySeries = new Map();
  let converted = 0;
  let skipped = 0;
  let notesTotal = 0;
  let fixedTotal = 0;
  let decimalFiles = 0;
  let problemFiles = 0;
  let cardFiles = 0;
  let multiFiles = 0;
  let programTotal = 0;

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
    const sections = splitPrograms(raw);
    const pieces = sections.programs.length
      ? sections.programs
      : [{ title: '', note: '', listing: raw.trim(), warn: [] }];

    if (pieces.length > 1) multiFiles += 1;
    programTotal += pieces.length;

    const parsedList = pieces.map((piece) => ({
      title: piece.title,
      note: piece.note,
      warn: piece.warn || [],
      parsed: parseListing(piece.listing),
    }));

    /* Карточка отделена, если до или после листинга что-то есть. */
    if (sections.before || sections.after) cardFiles += 1;
    if (!sections.programs.some((piece) => piece.listing)) {
      if (parsedList[0]) parsedList[0].parsed.problems.push('листинг не найден в файле — разобран весь текст');
    }

    const steps = parsedList.reduce((sum, item) => sum + item.parsed.rows.length, 0);
    const unknown = parsedList.reduce((sum, item) => sum + item.parsed.problems.length, 0);
    const notes = parsedList.reduce((sum, item) => sum + item.parsed.notes.length, 0);
    const fixed = parsedList.reduce((sum, item) => sum + item.parsed.fixed.length, 0);
    const decimal = parsedList.some((item) => item.parsed.decimal);

    if (decimal) decimalFiles += 1;
    notesTotal += notes;
    fixedTotal += fixed;

    const text = renderProgram(entry, parsedList, programPath, sections);

    const section = entry.section || path.dirname(programPath);
    const targetDir = path.join(OUT, section);
    ensureDir(targetDir);
    const targetName = path.basename(programPath, '.txt') + '.txt';
    fs.writeFileSync(path.join(targetDir, targetName), text, 'utf8');

    if (!bySection.has(section)) bySection.set(section, []);
    bySection.get(section).push({ entry, text, steps });

    if (entry.series) {
      const series = entry.series.trim();
      if (!bySeries.has(series)) bySeries.set(series, []);
      bySeries.get(series).push({ entry, text, steps });
    }

    index.push({
      section,
      program: programPath,
      title: entry.title || '',
      author: entry.author || '',
      kind: entry.kind || '',
      programs: parsedList.length,
      steps,
      unknown,
      notes,
      risk: riskOf(entry, programPath),
    });

    if (unknown) {
      problemFiles += 1;
      problemsOut.push(
        'games/' + programPath + ': не разобрано команд ' + unknown +
          (decimal ? ' (формат десятичных кодов)' : '') +
          (parsedList.length > 1 ? ' · программ в файле ' + parsedList.length : '')
      );
      parsedList.forEach((item, position) => {
        const prefix = parsedList.length > 1 ? '[программа ' + (position + 1) + '] ' : '';
        for (const warn of item.warn) problemsOut.push('    ' + prefix + 'структура: ' + warn);
        for (const problem of item.parsed.problems) problemsOut.push('    ' + prefix + problem);
      });
    }
    converted += 1;
  }

  for (const [section, items] of bySection) {
    const parts = ['Сборник раздела ' + section, 'Файлов: ' + items.length, ''];
    for (const item of items) {
      parts.push('='.repeat(60));
      parts.push('');
      parts.push(item.text);
      parts.push('');
    }
    fs.writeFileSync(path.join(OUT, '_sections', section + '.txt'), parts.join('\n'), 'utf8');
  }

  for (const [series, items] of bySeries) {
    const body = ['Сборник серии ' + series, 'Файлов: ' + items.length, ''];
    for (const item of items) {
      body.push('='.repeat(60));
      body.push('');
      body.push(item.text);
      body.push('');
    }
    const safe = series.replace(/[^A-Za-zА-Яа-я0-9._-]+/gu, '-');
    fs.writeFileSync(path.join(OUT, '_series', safe + '.txt'), body.join('\n'), 'utf8');
  }

  index.sort((a, b) => (a.section + '/' + a.program).localeCompare(b.section + '/' + b.program));
  const indexLines = ['раздел\tфайл\tназвание\tавтор\tтип\tпрограмм\tшагов\tне разобрано\tпримечаний\tриск'];
  for (const row of index) {
    indexLines.push(
      [
        row.section,
        row.program,
        row.title,
        row.author,
        row.kind,
        row.programs,
        row.steps,
        row.unknown,
        row.notes,
        row.risk,
      ].join('\t')
    );
  }
  fs.writeFileSync(path.join(OUT, '_index.tsv'), indexLines.join('\n') + '\n', 'utf8');

  const sectionsList = [...bySection.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const readme = [];
  readme.push('# Читаемый каталог семейства');
  readme.push('');
  readme.push('Собрано из `games/manifest.tsv` скриптом `scripts/export-readable.cjs`.');
  readme.push('Коды команд разобраны ядром MKPro; ожидаемый экран здесь не приводится.');
  readme.push('Листинг отделён от карточки, а файл с несколькими программами разделён');
  readme.push('модулем `scripts/readable-sections.cjs` — только по заголовкам в тексте,');
  readme.push('повтор адреса программу не разрезает.');
  readme.push('');
  readme.push('| Раздел | Файлов | Программ | Шагов всего |');
  readme.push('|:---|---:|---:|---:|');
  for (const [section, items] of sectionsList) {
    const total = items.reduce((sum, item) => sum + item.steps, 0);
    const count = items.reduce((sum, item) => {
      const parsed = 1;
      return sum + parsed;
    }, 0);
    readme.push('| ' + section + ' | ' + count + ' | ' + items.length + ' | ' + total + ' |');
  }
  readme.push('');
  readme.push('Всего переконвертировано файлов: **' + converted + '**');
  readme.push('Всего программ: ' + programTotal);
  readme.push('Файлов, где записано несколько программ: ' + multiFiles);
  readme.push('Пропущено записей без листинга: ' + skipped);
  readme.push('Файлов с замечаниями: ' + problemFiles);
  readme.push('Файлов, где карточка отделена от листинга: ' + cardFiles);
  readme.push('Файлов в формате десятичных кодов: ' + decimalFiles);
  readme.push('Отделено примечаний: ' + notesTotal);
  readme.push('Подписей приведено к формату ядра: ' + fixedTotal);
  readme.push('');
  readme.push('- `_index.tsv` — таблица всех программ, включая пометку риска');
  readme.push('- `_problems.txt` — что не разобралось и почему');
  readme.push('- `_sections/<раздел>.txt` — сборник раздела');
  if (bySeries.size) readme.push('- `_series/<серия>.txt` — сборник серии');
  readme.push('');
  readme.push('Ничего не угадывается: если подпись не совпала с таблицей ядра');
  readme.push('и не привелась однозначной нормализацией, она остаётся в `_problems.txt`.');
  fs.writeFileSync(path.join(OUT, 'README.md'), readme.join('\n'), 'utf8');

  const head = [
    '# Проблемы разбора',
    '# файлов с замечаниями: ' + problemFiles,
    '# файлов с несколькими программами: ' + multiFiles,
    '# карточек отделено от листинга: ' + cardFiles,
    '# примечаний отделено: ' + notesTotal,
    '# подписей нормализовано: ' + fixedTotal,
    '# файлов в формате десятичных кодов: ' + decimalFiles,
    '',
  ];
  fs.writeFileSync(
    path.join(OUT, '_problems.txt'),
    head.concat(problemsOut).join('\n') + '\n',
    'utf8'
  );

  console.log('переконвертировано файлов: ' + converted);
  console.log('программ всего: ' + programTotal);
  console.log('файлов с несколькими программами: ' + multiFiles);
  console.log('пропущено: ' + skipped);
  console.log('разделов: ' + sectionsList.length);
  console.log('серий: ' + bySeries.size);
  console.log('карточек отделено: ' + cardFiles);
  console.log('файлов с замечаниями: ' + problemFiles);
}

main();
