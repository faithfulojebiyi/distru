import { google as googleapis } from "googleapis"
import { afterEach, describe, expect, it } from "bun:test"

import type { Emulator } from "../src/define.ts"
import { googleSheets } from "../src/google/index.ts"
import { AUTH, authFor, consent, failure, fetchVia, googleWith } from "./google-api.ts"

const SHEET_ID = "1SheetsTestSpreadsheet000000000000000000000"

let emulator: Emulator

afterEach(async () => {
  await emulator.close()
})

function seeded(): Emulator {
  return googleWith({
    sheets: {
      "ada@danwo.test": [
        {
          spreadsheetId: SHEET_ID,
          title: "Reorders",
          tabs: [
            {
              title: "Weekly log",
              values: [
                ["Date", "Vendor", "SKU", "Qty"],
                ["2026-11-06", "Humboldt Heritage Farms", "FLW-BD-35", 240],
              ],
            },
            { title: "Notes", values: [["free text"]] },
          ],
        },
      ],
    },
  })
}

async function sheetsAs(email: string, scopes: readonly string[] = [`${AUTH}spreadsheets`]) {
  const tokens = await consent(emulator, email, scopes)

  return googleapis.sheets({ version: "v4", auth: authFor(emulator, tokens), fetchImplementation: fetchVia(emulator) })
}

describe("Sheets values", () => {
  it("reads, appends after the table, and clears ranges", async () => {
    emulator = seeded()
    const ada = await sheetsAs("ada@danwo.test")

    const info = await ada.spreadsheets.get({ spreadsheetId: SHEET_ID })
    expect(info.data.properties?.title).toBe("Reorders")
    expect(info.data.sheets?.map((s) => s.properties?.title)).toEqual(["Weekly log", "Notes"])

    const got = await ada.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'Weekly log'!A1:D" })
    expect(got.data.values).toEqual([
      ["Date", "Vendor", "SKU", "Qty"],
      ["2026-11-06", "Humboldt Heritage Farms", "FLW-BD-35", "240"],
    ])

    const appended = await ada.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "'Weekly log'!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["2026-11-20", "Sierra Extracts Co.", "VAP-BD-1G", 150], ["2026-11-20", "Mojave Pre-Roll Co.", "PRE-BD-1G", 500]] },
    })
    expect(appended.data.tableRange).toBe("'Weekly log'!A1:D2")
    expect(appended.data.updates).toMatchObject({ updatedRange: "'Weekly log'!A3:D4", updatedRows: 2, updatedCells: 8 })

    const batch = await ada.spreadsheets.values.batchGet({ spreadsheetId: SHEET_ID, ranges: ["'Weekly log'!A3:D4", "Notes"] })
    expect(batch.data.valueRanges?.[0]?.values).toEqual([
      ["2026-11-20", "Sierra Extracts Co.", "VAP-BD-1G", "150"],
      ["2026-11-20", "Mojave Pre-Roll Co.", "PRE-BD-1G", "500"],
    ])
    expect(batch.data.valueRanges?.[1]?.values).toEqual([["free text"]])

    const cleared = await ada.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: "'Weekly log'!A3:D4" })
    expect(cleared.data.clearedRange).toBe("'Weekly log'!A3:D4")
    expect(googleSheets(emulator, "ada@danwo.test").values(SHEET_ID, "'Weekly log'")).toHaveLength(2)
  })

  it("refuses other users' spreadsheets, missing scopes and bad input", async () => {
    emulator = seeded()
    const bob = await sheetsAs("bob@danwo.test")
    expect((await failure(bob.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "A1" }))).status).toBe(404)

    const readOnly = await sheetsAs("ada@danwo.test", [`${AUTH}spreadsheets.readonly`])
    const denied = await failure(
      readOnly.spreadsheets.values.append({ spreadsheetId: SHEET_ID, range: "A1", valueInputOption: "RAW", requestBody: { values: [["x"]] } }),
    )
    expect(denied).toEqual({ status: 403, reason: "insufficientPermissions" })

    const ada = await sheetsAs("ada@danwo.test")
    expect((await failure(ada.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "'No such tab'!A1" }))).status).toBe(400)
  })
})
