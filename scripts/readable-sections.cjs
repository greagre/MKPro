'use strict';

/*
 * readable-sections.cjs — отделяет листинг от карточки игры.
 *
 * Проблема: в games/*.txt у части программ (особенно переписанных из тетрадей
 * и с форумов) лежит не только листинг, а целая карточка: автор, источник,
 * описание уровней, ASCII-поле, таблица символов, «Исходные данные», советы.
 * Парсер читал всё это как команды и выдавал десятки «не разобрано».
 *
 * Что делает модуль: режет файл на три части.
 *   before  — всё до листинга (карточка: название, автор, источник);
 *   listing — только строки с адресом и командой;
 *   after   — всё после листинга (описание, примечания, регистры).
 *
 * Правила поиска:
 *   начало — строка «Листинг» (или «Листинг программы»), иначе первая
 *            строка, начинающаяся с адреса (00…6E, -0…-4, A0…A4);
 *   конец  — первый заголовок из стоп-списка или длинная строка (>60 знаков)
 *            после того, как набралось хотя бы три адресные строки.
 *
 * Чего НЕ делает: не пытается понять смысл описания и ничего не изменяет
 * в самих строках листинга — это работа вызывающего кода.
 */

/* Адресная строка: адрес, пробел, что угодно. */
const ADDRESS_LINE = /^\s*(-[0-4]|[0-9A-Fa-f]{2}|[АA][0-4])\s+\S/u;

/* Строка-комментарий внутри листинга — не завершает его. */
const COMMENT_LINE = /^\s*(#|\/\/|;|—|–|--)/u;

/* Заголовок, после которого начинается листинг. */
const LISTING_HEADER = /^\s*листинг\b/iu;

/* Заголовки, которые означают «листинг закончился». */
const STOP_HEADER =
  /^\s*(исходные\s+данные|описание|текст\s+игры|символы|коды|примечания|регистры|управление|совет|как\s+играть|правила|пример\s+прогона|результат|автор|источник|дата|коллекция|теги|название)\b/iu;

function isAddressLine(line) {
  return ADDRESS_LINE.test(line);
}

function splitListing(raw) {
  if (!raw || !raw.trim()) return { before: '', listing: '', after: '' };

  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  /* 1. Начало листинга: сначала ищем явный заголовок. */
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (LISTING_HEADER.test(lines[i])) {
      start = i + 1;
      break;
    }
  }

  /* 2. Заголовка нет — берём первую адресную строку. */
  if (start < 0) {
    for (let i = 0; i < lines.length; i += 1) {
      if (isAddressLine(lines[i])) {
        start = i;
        break;
      }
    }
  }

  /* 3. Ни заголовка, ни адресов — файл не про листинг, отдаём как есть. */
  if (start < 0) return { before: '', listing: raw.trim(), after: '' };

  /* 4. Конец листинга. */
  let end = lines.length;
  let addressLines = 0;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (isAddressLine(line)) {
      addressLines += 1;
      continue;
    }
    if (COMMENT_LINE.test(line)) continue;
    if (addressLines >= 3) {
      if (STOP_HEADER.test(line)) {
        end = i;
        break;
      }
      if (line.trim().length > 60) {
        end = i;
        break;
      }
    }
  }

  const before = lines.slice(0, start).join('\n').trim();
  const listing = lines.slice(start, end).join('\n').trim();
  const after = lines.slice(end).join('\n').trim();

  return { before, listing, after };
}

/* Есть ли в выделенной части хоть одна адресная строка. */
function hasListing(parts) {
  return Boolean(
    parts && parts.listing && /[0-9A-Fa-fАA][0-9A-Fa-f]\s+\S/u.test(parts.listing)
  );
}

module.exports = { splitListing, hasListing, isAddressLine, ADDRESS_LINE };

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('укажи файл листинга: node scripts/readable-sections.cjs games/logic/xxx.txt');
    process.exit(1);
  }
  const parts = splitListing(fs.readFileSync(file, 'utf8'));
  const count = (text) => (text ? text.split('\n').filter((line) => line.trim()).length : 0);
  console.log('до листинга: ' + count(parts.before) + ' строк');
  console.log('листинг: ' + count(parts.listing) + ' строк');
  console.log('после листинга: ' + count(parts.after) + ' строк');
}
