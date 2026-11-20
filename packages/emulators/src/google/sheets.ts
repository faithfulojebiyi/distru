import { randomBytes } from "node:crypto"

import type { Emulator } from "../define.ts"
import type { Store } from "../store.ts"
import { badRequest, notFound } from "./api.ts"
import type { GoogleUser, SpreadsheetRecord, SpreadsheetTab } from "./entities.ts"
import { googleStore } from "./store.ts"

/**
 * Google Sheets: spreadsheets with tabs of cell values, addressed in A1 notation
 * (`'Weekly reorder log'!A2:J`). Values are kept as the formatted strings the API returns by
 * default; numbers and booleans written with `USER_ENTERED` or `RAW` are stored as their text.
 */

/** A cell rectangle on one tab: zero-based, `endRow` / `endCol` exclusive, `null` = unbounded. */
export interface GridRange {
  readonly sheet: string
  readonly startRow: number
  readonly endRow: number | null
  readonly startCol: number
  readonly endCol: number | null
}

const CELL = /^([A-Za-z]*)(\d*)$/

/** `A` → 0, `Z` → 25, `AA` → 26. */
export function columnIndex(letters: string): number {
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1
}

/** 0 → `A`, 26 → `AA`. */
export function columnLetters(index: number): string {
  let n = index + 1
  let out = ""

  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }

  return out
}

/** A tab name as A1 notation writes it: quoted unless it is a plain word. */
export function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`
}

/** Splits `'My tab'!A1:B2` into the tab name (unquoted) and the cell part. */
function splitRange(range: string): { readonly sheet: string | null; readonly cells: string } {
  const trimmed = range.trim()

  if (trimmed.startsWith("'")) {
    let i = 1
    let name = ""

    while (i < trimmed.length) {
      if (trimmed[i] === "'" && trimmed[i + 1] === "'") {
        name += "'"
        i += 2
      } else if (trimmed[i] === "'") break
      else name += trimmed[i++]
    }

    const rest = trimmed.slice(i + 1)

    return { sheet: name, cells: rest.startsWith("!") ? rest.slice(1) : rest }
  }

  const bang = trimmed.lastIndexOf("!")

  return bang === -1
    ? { sheet: null, cells: trimmed }
    : { sheet: trimmed.slice(0, bang), cells: trimmed.slice(bang + 1) }
}

/**
 * Parses an A1 range against a spreadsheet: `Tab`, `Tab!A1`, `Tab!A1:D`, `Tab!A:D`, `Tab!2:5`, or
 * just `A1:D5` (the first tab). A bare word that names a tab is that whole tab.
 */
export function parseA1(record: SpreadsheetRecord, range: string): GridRange {
  const split = splitRange(range)
  let sheet = split.sheet
  let cells = split.cells

  if (sheet === null && record.tabs.some((tab) => tab.title === cells)) {
    sheet = cells
    cells = ""
  }

  const tab = sheet === null ? record.tabs[0] : record.tabs.find((t) => t.title === sheet)

  if (!tab) throw badRequest(`Unable to parse range: ${range}`, "badRequest")
  if (cells === "") return { sheet: tab.title, startRow: 0, endRow: null, startCol: 0, endCol: null }

  const [from = "", to] = cells.split(":")
  const a = CELL.exec(from)
  const b = to === undefined ? a : CELL.exec(to)

  if (!a || !b || (a[1] === "" && a[2] === "") || (b[1] === "" && b[2] === ""))
    throw badRequest(`Unable to parse range: ${range}`, "badRequest")

  const col = (letters: string | undefined, fallback: number) =>
    letters ? columnIndex(letters) : fallback
  const row = (digits: string | undefined, fallback: number) =>
    digits ? Number(digits) - 1 : fallback
  const startCol = col(a[1], 0)
  const startRow = row(a[2], 0)
  const endCol = b[1] ? columnIndex(b[1]) + 1 : null
  const endRow = b[2] ? Number(b[2]) : null

  return { sheet: tab.title, startRow, endRow, startCol, endCol }
}

/** A1 text for a bounded grid range on `sheet`. */
export function formatA1(sheet: string, startRow: number, startCol: number, endRow: number, endCol: number): string {
  const from = `${columnLetters(startCol)}${startRow + 1}`
  const to = `${columnLetters(endCol - 1)}${endRow}`

  return `${quoteSheet(sheet)}!${from === to ? from : `${from}:${to}`}`
}

/** A cell value as the API stores and returns it (formatted text). */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "number") return String(value)

  return JSON.stringify(value)
}

/** Drops trailing empty cells and rows, as the API leaves them out. */
function trimmed(values: string[][]): string[][] {
  const rows = values.map((row) => {
    let end = row.length

    while (end > 0 && row[end - 1] === "") end--

    return row.slice(0, end)
  })
  let last = rows.length

  while (last > 0 && rows[last - 1]?.length === 0) last--

  return rows.slice(0, last)
}

function tabOf(record: SpreadsheetRecord, title: string): SpreadsheetTab {
  const tab = record.tabs.find((t) => t.title === title)

  if (!tab) throw badRequest(`Unable to parse range: ${title}`)

  return tab
}

/** The values in a range, trimmed like the API, and the range as the API names it back. */
export function readRange(
  record: SpreadsheetRecord,
  range: string,
): { readonly range: string; readonly values: string[][] } {
  const grid = parseA1(record, range)
  const tab = tabOf(record, grid.sheet)
  const rowEnd = grid.endRow ?? Math.max(tab.values.length, grid.startRow + 1)
  const width = Math.max(1, ...tab.values.map((r) => r.length))
  const colEnd = grid.endCol ?? Math.max(width, grid.startCol + 1)
  const values: string[][] = []

  for (let r = grid.startRow; r < rowEnd; r++) {
    const row = tab.values[r] ?? []
    const cells: string[] = []

    for (let c = grid.startCol; c < colEnd; c++) cells.push(row[c] ?? "")
    values.push(cells)
  }

  // An unbounded range is reported up to the last row/column with data (or its start cell).
  const shown = trimmed(values)
  const reportedRowEnd = grid.endRow ?? Math.max(grid.startRow + 1, grid.startRow + shown.length)
  const reportedColEnd =
    grid.endCol ?? Math.max(grid.startCol + 1, grid.startCol + Math.max(0, ...shown.map((r) => r.length)))

  return {
    range: formatA1(grid.sheet, grid.startRow, grid.startCol, reportedRowEnd, reportedColEnd),
    values: shown,
  }
}

/** The data table a range starts in: its rows from the first non-empty one down to the last. */
function lastDataRow(tab: SpreadsheetTab, grid: GridRange): number {
  let last = -1

  for (let r = 0; r < tab.values.length; r++) {
    const row = tab.values[r] ?? []
    const end = grid.endCol ?? row.length
    const hasData = row.slice(grid.startCol, end).some((cell) => cell !== "")

    if (hasData && r >= grid.startRow) last = r
  }

  return last
}

export interface AppendResult {
  readonly tableRange: string | null
  readonly updatedRange: string
  readonly updatedRows: number
  readonly updatedColumns: number
  readonly updatedCells: number
  readonly values: string[][]
}

/**
 * Appends rows after the last row with data in the range's columns (the API's "table"), starting at
 * the range's first column; `INSERT_ROWS` and `OVERWRITE` behave the same on this grid.
 */
export function appendRows(record: SpreadsheetRecord, range: string, rows: readonly (readonly unknown[])[]): AppendResult {
  const grid = parseA1(record, range)
  const tab = tabOf(record, grid.sheet)
  const last = lastDataRow(tab, grid)
  const start = Math.max(last + 1, grid.startRow)
  const width = Math.max(0, ...rows.map((r) => r.length))
  const written = rows.map((r) => r.map(cellText))

  written.forEach((cells, i) => {
    const target = tab.values[start + i] ?? []

    while (tab.values.length <= start + i) tab.values.push([])
    while (target.length < grid.startCol) target.push("")
    cells.forEach((cell, c) => {
      target[grid.startCol + c] = cell
    })
    tab.values[start + i] = target
  })

  const tableRange =
    last >= grid.startRow
      ? formatA1(grid.sheet, grid.startRow, grid.startCol, last + 1, grid.startCol + Math.max(width, 1))
      : null

  return {
    tableRange,
    updatedRange: formatA1(grid.sheet, start, grid.startCol, start + written.length, grid.startCol + Math.max(width, 1)),
    updatedRows: written.length,
    updatedColumns: width,
    updatedCells: written.reduce((n, r) => n + r.length, 0),
    values: written,
  }
}

/** Empties every cell in the range (rows stay; trailing empty rows drop out of reads). */
export function clearRange(record: SpreadsheetRecord, range: string): string {
  const grid = parseA1(record, range)
  const tab = tabOf(record, grid.sheet)
  const rowEnd = grid.endRow ?? tab.values.length

  for (let r = grid.startRow; r < Math.min(rowEnd, tab.values.length); r++) {
    const row = tab.values[r] ?? []
    const colEnd = grid.endCol ?? row.length

    for (let c = grid.startCol; c < Math.min(colEnd, row.length); c++) row[c] = ""
  }

  tab.values = trimmed(tab.values).map((row) => [...row])

  return formatA1(
    grid.sheet,
    grid.startRow,
    grid.startCol,
    grid.endRow ?? Math.max(grid.startRow + 1, rowEnd),
    grid.endCol ?? grid.startCol + 1,
  )
}

/** The spreadsheet `id` the caller may use (its owner), or a 404. */
export function spreadsheetFor(store: Store, user: GoogleUser, spreadsheetId: string): SpreadsheetRecord {
  const record = googleStore(store).spreadsheets.findOneBy("spreadsheetId", spreadsheetId)

  if (!record || record.owner !== user.uid) throw notFound()

  return record
}

/** Saves a spreadsheet's changed tabs. */
export function saveSpreadsheet(store: Store, record: SpreadsheetRecord): void {
  googleStore(store).spreadsheets.update(record.id, { tabs: record.tabs.map((t) => ({ ...t, values: t.values.map((r) => [...r]) })) })
}

/** A new spreadsheet id: 44 URL-safe characters like Google's. */
export const newSpreadsheetId = (): string => `1${randomBytes(33).toString("base64url").slice(0, 43)}`

/** The spreadsheet resource `spreadsheets.get` returns (no grid data). */
export function spreadsheetResource(record: SpreadsheetRecord) {
  return {
    spreadsheetId: record.spreadsheetId,
    properties: { title: record.title, locale: "en_US", timeZone: "America/Los_Angeles" },
    sheets: record.tabs.map((tab, index) => ({
      properties: {
        sheetId: tab.sheetId,
        title: tab.title,
        index,
        sheetType: "GRID",
        gridProperties: {
          rowCount: Math.max(1000, tab.values.length),
          columnCount: Math.max(26, ...tab.values.map((r) => r.length)),
        },
      },
    })),
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${record.spreadsheetId}/edit`,
  }
}

/** A spreadsheet already in a user's Drive when the emulator starts. */
export interface SheetsSeedSpreadsheet {
  /** Fixed id, so an app's config can name it; random otherwise. */
  readonly spreadsheetId?: string
  readonly title: string
  readonly tabs: readonly { readonly title: string; readonly values: readonly (readonly unknown[])[] }[]
}

export function insertSpreadsheet(store: Store, owner: GoogleUser, seed: SheetsSeedSpreadsheet): SpreadsheetRecord {
  return googleStore(store).spreadsheets.insert({
    spreadsheetId: seed.spreadsheetId ?? newSpreadsheetId(),
    owner: owner.uid,
    title: seed.title,
    tabs: (seed.tabs.length ? seed.tabs : [{ title: "Sheet1", values: [] }]).map((tab, i) => ({
      sheetId: i === 0 ? 0 : 1_000_000 + i,
      title: tab.title,
      values: tab.values.map((row) => row.map(cellText)),
    })),
  })
}

export function seedSheets(store: Store, sheets: Readonly<Record<string, readonly SheetsSeedSpreadsheet[]>>): void {
  for (const [email, spreadsheets] of Object.entries(sheets)) {
    const user = googleStore(store).users.findOneBy("email", email)

    if (!user) throw new Error(`seedGoogle: sheets for ${email}, who is not among the users`)

    for (const spreadsheet of spreadsheets) insertSpreadsheet(store, user, spreadsheet)
  }
}

/** Reads `email`'s spreadsheets from a test. */
export interface GoogleSheets {
  /** The user's spreadsheets: id, title and tab names. */
  spreadsheets(): { spreadsheetId: string; title: string; tabs: string[] }[]
  /** A range's values, as `spreadsheets.values.get` returns them. */
  values(spreadsheetId: string, range: string): string[][]
}

export function googleSheets(emulator: Pick<Emulator, "store">, email: string): GoogleSheets {
  const user = () => {
    const users = googleStore(emulator.store).users
    const found = users.findOneBy("email", email.toLowerCase()) ?? users.findOneBy("email", email)

    if (!found) throw new Error(`no Google account ${email}`)

    return found
  }

  return {
    spreadsheets: () =>
      googleStore(emulator.store)
        .spreadsheets.all()
        .filter((s) => s.owner === user().uid)
        .map((s) => ({ spreadsheetId: s.spreadsheetId, title: s.title, tabs: s.tabs.map((t) => t.title) })),
    values: (spreadsheetId, range) => readRange(spreadsheetFor(emulator.store, user(), spreadsheetId), range).values,
  }
}
