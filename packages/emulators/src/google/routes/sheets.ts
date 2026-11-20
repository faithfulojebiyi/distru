import type { Context } from "../../http.ts"
import { badRequest, jsonBody, queryAll, requireAccess } from "../api.ts"
import type { GoogleRouteContext } from "../context.ts"
import { SCOPES } from "../scopes.ts"
import {
  appendRows,
  clearRange,
  readRange,
  saveSpreadsheet,
  spreadsheetFor,
  spreadsheetResource,
} from "../sheets.ts"

const SPREADSHEET = "/v4/spreadsheets/:spreadsheetId"

/** `Tab!A1:B2:append` → the range and the custom method (`append`, `clear`), if any. */
function rangeAndMethod(raw: string): { readonly range: string; readonly method: string | null } {
  const match = /^(.*):(append|clear)$/.exec(raw)

  return match ? { range: match[1] ?? "", method: match[2] ?? null } : { range: raw, method: null }
}

const valueRange = (range: string, values: string[][]) => ({
  range,
  majorDimension: "ROWS",
  ...(values.length > 0 && { values }),
})

const isRows = (value: unknown): value is unknown[][] =>
  Array.isArray(value) && value.every((row) => Array.isArray(row))

/**
 * Sheets API v4: `spreadsheets.get`, `values.get`, `values.batchGet`, `values.append`,
 * `values.clear` and `values.batchClear`, each checked against the token's scopes and limited to
 * the caller's own spreadsheets.
 */
export function sheetsRoutes(context: GoogleRouteContext): void {
  const { app, store } = context

  const read = (c: Context) => {
    const caller = requireAccess(c, context, SCOPES.sheetsRead)

    return spreadsheetFor(store, caller.user, c.req.param("spreadsheetId"))
  }
  const write = (c: Context) => {
    const caller = requireAccess(c, context, SCOPES.sheetsWrite)

    return spreadsheetFor(store, caller.user, c.req.param("spreadsheetId"))
  }

  app.get(SPREADSHEET, (c) => c.json(spreadsheetResource(read(c))))

  app.get(`${SPREADSHEET}/values:batchGet`, (c) => {
    const record = read(c)
    const ranges = queryAll(c, "ranges")

    if (ranges.length === 0) throw badRequest("Must specify at least one range.")

    return c.json({
      spreadsheetId: record.spreadsheetId,
      valueRanges: ranges.map((range) => {
        const got = readRange(record, range)

        return valueRange(got.range, got.values)
      }),
    })
  })

  app.post(`${SPREADSHEET}/values:batchClear`, async (c) => {
    const record = write(c)
    const ranges = (await jsonBody(c))["ranges"]

    if (!Array.isArray(ranges) || ranges.length === 0)
      throw badRequest("Must specify at least one range.")

    const clearedRanges = ranges.map((range) => clearRange(record, String(range)))

    saveSpreadsheet(store, record)

    return c.json({ spreadsheetId: record.spreadsheetId, clearedRanges })
  })

  app.get(`${SPREADSHEET}/values/:range`, (c) => {
    const record = read(c)
    const got = readRange(record, c.req.param("range"))

    return c.json(valueRange(got.range, got.values))
  })

  app.post(`${SPREADSHEET}/values/:range`, async (c) => {
    const { range, method } = rangeAndMethod(c.req.param("range"))
    const record = write(c)

    if (method === "clear") {
      const clearedRange = clearRange(record, range)

      saveSpreadsheet(store, record)

      return c.json({ spreadsheetId: record.spreadsheetId, clearedRange })
    }

    if (method !== "append") throw badRequest(`Unknown method on ${range}.`)

    const option = c.req.query("valueInputOption")

    if (option !== "RAW" && option !== "USER_ENTERED")
      throw badRequest("Invalid valueInputOption: must be RAW or USER_ENTERED.")

    const body = await jsonBody(c)
    const values = body["values"]

    if (!isRows(values)) throw badRequest("Invalid values: expected an array of rows.")

    const result = appendRows(record, range, values)

    saveSpreadsheet(store, record)

    const updates = {
      spreadsheetId: record.spreadsheetId,
      updatedRange: result.updatedRange,
      updatedRows: result.updatedRows,
      updatedColumns: result.updatedColumns,
      updatedCells: result.updatedCells,
      ...(c.req.query("includeValuesInResponse") === "true" && {
        updatedData: valueRange(result.updatedRange, result.values),
      }),
    }

    return c.json({
      spreadsheetId: record.spreadsheetId,
      ...(result.tableRange && { tableRange: result.tableRange }),
      updates,
    })
  })
}
