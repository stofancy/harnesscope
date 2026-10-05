import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inputDate, dateInput, deltaPercent } from "./format.ts";
test("precise timezone conversion roundtrips seconds", () => {
    const iso = inputDate("2026-10-05T14:12:36", "Asia/Singapore");
    assert.equal(iso, "2026-10-05T06:12:36.000Z");
    assert.equal(dateInput(iso, "Asia/Singapore"), "2026-10-05T14:12:36");
});
test("timezone determines instant, including negative offsets", () =>
    assert.equal(
        inputDate("2026-10-05T14:12:00", "America/New_York"),
        "2026-10-05T18:12:00.000Z",
    ));
test("nonexistent DST time rejected", () =>
    assert.throws(() => inputDate("2026-03-08T02:30:00", "America/New_York")));
test("zero comparison never renders infinity", () => {
    assert.equal(deltaPercent(5, 0), "新增");
    assert.equal(deltaPercent(null, 0), null);
});
