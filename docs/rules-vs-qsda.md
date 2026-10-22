# Наши правила и флаги QSDA Pro V3.7

Сгенерировано: `node scripts/gen-rules-vs-qsda.mjs`.
Справочник QSDA с описаниями: [qsda-flags-v3.7.md](./qsda-flags-v3.7.md).

**Покрытие: 24 из 39 флагов QSDA V3.7.**

## Соответствие

| Флаг QSDA | Наши правила | Статус |
|---|---|---|
| 0-row Table | `R006` | ✅ |
| 100 Pct Null field | `R005` | ✅ |
| All fields unused but keys | `R003` | ✅ |
| Bookmark Field not Found | — | ⛔ |
| Calculated Dimension | `P006` | ✅ |
| Circular Reference | — | ⛔ |
| Conditional Aggregation | `P011` | ✅ |
| Data Island Expression | `P008` | ✅ |
| DeprecatedVisualization | `R014` | ✅ |
| Dimension Syntax Error | `Q001` | ✅ |
| Duplicate Name | `P004` | ✅ |
| Expression Matching Measure | `P002` | ✅ |
| Expression Syntax Error | `Q001` | ✅ |
| Key can be Autonumbered | `R007` | ✅ |
| Key Field Used in Expression | `P003`, `S006` | ✅ |
| Master Dimension Duplicate Definition | — | ⛔ |
| Master Dimension Duplicate Label | — | ⛔ |
| Master Dimension Duplication | — | ⛔ |
| Master Item holding unused field | — | ⛔ |
| Master Measure Duplicate Definition | — | ⛔ |
| Master Measure Duplicate Label | — | ⛔ |
| Master Measure Duplication | — | ⛔ |
| Missing Action Target | — | ⛔ |
| Missing Extension | — | ⛔ |
| Missing Key value | `R010` | ✅ |
| Missing Master Dimension | — | ⛔ |
| Missing Master Measure | — | ⛔ |
| Missing Master Visualization | — | ⛔ |
| Missing Theme | — | ⛔ |
| Multi Table Expression | `P007` | ✅ |
| No Application Thumbnail | `R013` | ✅ |
| Parse Error | `Q004`, `S010` | ✅ |
| Repeating Expression | `P001` | ✅ |
| Suboptimal numeric storage | `R012` | ✅ |
| Synthetic Key field | `P012` | ✅ |
| Synthetic Key table | `P005`, `S004` | ✅ |
| Tables can be Outer Joined | `R011` | ✅ |
| Unrecognized Name | `Q002`, `Q003`, `S009` | ✅ |
| Unused Field | `R001`, `R002`, `S007` | ✅ |

## Наши правила без аналога в QSDA

| ID | Категория | Правило | Флаг QSDA |
|---|---|---|---|
| `P009` | Practices | Сложное выражение | — |
| `P010` | Practices | Несогласованное именование | — |
| `Q005` | Quality | Пустое выражение | — |
| `Q006` | Quality | Объект без описания | — |
| `Q007` | Quality | Переменная без описания | — |
| `R004` | Resources | Неиспользуемая переменная | — |
| `R008` | Resources | Лист без объектов | — |
| `R009` | Resources | Поле-константа | — |
| `S001` | Script | Загрузка без явного списка полей | — |
| `S002` | Script | Загрузка без фильтра WHERE | — |
| `S003` | Script | Цепочка RESIDENT | — |
| `S005` | Script | Повторная загрузка таблицы | — |
| `S008` | Script | Неиспользуемая переменная скрипта | — |
| `S011` | Script | Скрипт без комментариев | — |
| `S012` | Script | Загрузка файла без указания формата | — |

## Не реализовано (осознанный долг)

- **Bookmark Field not Found** — bookmarkmissingfield
- **Circular Reference** — circularreference
- **Master Item holding unused field** — holdingunusedfield
- **Master Dimension Duplicate Definition** — masterdimduplicatedef
- **Master Dimension Duplicate Label** — masterdimduplicatelabel
- **Master Dimension Duplication** — masterdimduplicate
- **Master Measure Duplicate Definition** — mastermeasduplicatedef
- **Master Measure Duplicate Label** — mastermeasduplicatelabel
- **Master Measure Duplication** — mastermeasduplicate
- **Missing Action Target** — missingactiontarget
- **Missing Extension** — missingextension
- **Missing Master Dimension** — missingmasterdimension
- **Missing Master Measure** — missingmastermeasure
- **Missing Master Visualization** — missingmasterviz
- **Missing Theme** — missingtheme

Большинство из них требуют master items, закладок, расширений и тем —
то есть доступны только в Qlik Sense. В QlikView 12 эти проверки помечаются
«не применимо».
