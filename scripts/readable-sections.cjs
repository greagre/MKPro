'use strict';

/*
 * readable-sections.cjs — отделяет листинг от карточки игры
 * и делит файл на отдельные программы.
 *
 * Проблема 1: в games/*.txt у части программ (особенно из тетрадей и с форумов)
 * лежит не только листинг, а целая карточка: автор, источник, описание уровней,
 * ASCII-поле, таблица символов, «Исходные данные», советы. Парсер читал это
 * как команды и выдавал десятки «не разобрано».
 *
 * Проблема 2: в одном файле нередко записано несколько программ — вариантов
 * одной игры или ступеней одного расчёта (loterei-kubik, apollo11-launch,
 * beskonechnaya-istoriya, domino-vunderkind, kombinator). Адреса в них
 * начинаются с 00 заново, и разбор в один список давал ложные
 * «адрес задан дважды» на весь второй вариант.
 *
 * Что делает модуль: режет файл на три части.
 *   before   — всё до первой программы (карточка: название, автор, источник);
 *   programs — массив программ: заголовок, описание, только строки листинга;
 *   after    — всё после последней программы (примечания, регистры, советы).
 *
 * Как программы отделяются друг от друга:
 *   1. любой непустой текст между адресными строками закрывает программу,
 *      а следующий блок адресных строк открывает новую;
 *   2. если адрес внутри текущей программы повторился — начинается новая
 *      программа, а в warn попадает честная пометка «адрес повторён».
 *      Это не догадка о смысле, а структура: одна ячейка — одно значение.
 *
 * Чего НЕ делает: не понимает смысл описания, не правит сами строки
 * листинга и ничего не решает за автора — это работа вызывающего кода.
 */

/* Адресная строка: адрес, пробел, что угодно. */
const ADDRESS_LINE = /^\s*(-[0-4]|[0-9A-Fa-f]{2}|[АA][0-4])\s+\S/u;

/* Строка-комментарий внутри листинга — не завершает его. */
const COMMENT_LINE = /^\s*(#|\/\/|;|—|–|--)/u;

/* Заголовок, после которого начинается листинг (это маркер, а не текст карточки). */
const LISTING_HEADER = /^\s*листинг\b/iu;

function isAddressLine(line) {
  return ADDRESS_LINE.test(line);
}

/* Адрес в каноническом виде: 0…104. «-0»…«-4» и «A0»…«A4» — это 100…104. */
function addressKey(line) {
  const match = line.match(ADDRESS_LINE);
  if (!match) return '';
  const token = match[1].toUpperCase();
  if (/^[АA][0-4]$/u.test(token)) return String(100 + Number(token.slice(1)));
  if (token.startsWith('-')) return String(100 + Number(token.slice(1)));
  return String(parseInt(token, 16));
}

/*
 * Основная функция: возвращает { before, programs, after }.
 * programs[i] = { title, note, listing, warn }
 */
function splitPrograms(raw) {
  if (!raw || !raw.trim()) return { before: '', programs: [], after: '' };

  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  const items = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (current) current.lines.push(line);
      continue;
    }

    /* Маркер «Листинг» — не часть описания. */
    if (LISTING_HEADER.test(line)) continue;

    if (COMMENT_LINE.test(line)) {
      if (current) current.lines.push(line);
      continue;
    }

    if (isAddressLine(line)) {
      const key = addressKey(line);
      const repeated = Boolean(
        current && current.kind === 'prog' && current.addresses.has(key)
      );
      if (!current || current.kind !== 'prog' || repeated) {
        current = { kind: 'prog', lines: [], addresses: new Set(), warn: [] };
        if (repeated) {
          current.warn.push('адрес ' + key + ' повторён — с этого места считаю новой программой');
        }
        items.push(current);
      }
      current.lines.push(line);
      current.addresses.add(key);
      continue;
    }

    /* Любой другой текст закрывает программу. */
    if (!current || current.kind !== 'text') {
      current = { kind: 'text', lines: [] };
      items.push(current);
    }
    current.lines.push(line);
  }

  const programs = [];
  const before = [];
  let after = [];
  let pending = [];
  let sawProgram = false;

  for (const item of items) {
    if (item.kind === 'text') {
      if (!sawProgram) before.push(...item.lines);
      else pending.push(...item.lines);
      continue;
    }
    const text = pending.join('\n').trim();
    const lastLine = text.split('\n').map((part) => part.trim()).filter(Boolean).pop() || '';
    programs.push({
      title: lastLine.replace(/\s*:\s*$/, ''),
      note: text,
      listing: item.lines.join('\n').trim(),
      warn: item.warn,
    });
    pending = [];
    sawProgram = true;
  }
  after = pending;

  return {
    before: before.join('\n').trim(),
    programs,
    after: after.join('\n').trim(),
  };
}

/*
 * Старый вид ответа — одна программа. Оставлен для совместимости:
 * если в файле несколько программ, в listing попадает первая,
 * а остальные уходят в after вместе со своими заголовками.
 */
function splitListing(raw) {
  const parts = splitPrograms(raw);
  if (!parts.programs.length) {
    return { before: parts.before, listing: String(raw || '').trim(), after: parts.after };
  }
  const first = parts.programs[0];
  const listing = [first.title ? first.title + ':' : '', first.listing].filter(Boolean).join('\n');
  const rest = parts.programs
    .slice(1)
    .map((program) => [program.title ? program.title + ':' : '', program.listing].filter(Boolean).join('\n'))
    .join('\n\n');
  return {
    before: parts.before,
    listing,
    after: [rest, parts.after].filter(Boolean).join('\n\n'),
  };
}

/* Есть ли в выделенной части хоть одна адресная строка. */
function hasListing(parts) {
  if (parts && Array.isArray(parts.programs)) {
    return parts.programs.some((program) => Boolean(program.listing && program.listing.trim()));
  }
  return Boolean(
    parts && parts.listing && /[0-9A-Fa-fАA][0-9A-Fa-f]\s+\S/u.test(parts.listing)
  );
}

module.exports = { splitPrograms, splitListing, hasListing, isAddressLine, addressKey, ADDRESS_LINE };

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('укажи файл листинга: node scripts/readable-sections.cjs games/logic/xxx.txt');
    process.exit(1);
  }
  const parts = splitPrograms(fs.readFileSync(file, 'utf8'));
  const count = (text) => (text ? text.split('\n').filter((line) => line.trim()).length : 0);
  console.log('до листинга: ' + count(parts.before) + ' строк');
  console.log('программ в файле: ' + parts.programs.length);
  parts.programs.forEach((program, index) => {
    console.log(
      '  ' + (index + 1) + '. ' + (program.title || '(без заголовка)') +
        ' — ' + count(program.listing) + ' строк листинга'
    );
    for (const warn of program.warn) console.log('     ! ' + warn);
  });
  console.log('после листинга: ' + count(parts.after) + ' строк');
}
