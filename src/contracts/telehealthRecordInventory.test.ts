import { describe, expect, it } from "vitest";
import { TELEHEALTH_RECORD_LOCATIONS, telehealthRecordLocation } from "./telehealthRecordInventory";

/**
 * The inventory is a statement about where telehealth text lives and what each
 * control can truthfully say. These tests keep it honest: every location is
 * accounted for, no location claims an erasure receipt, provider and backup
 * copies are never "covered", and no retention duration is invented.
 */
describe("telehealth record inventory contract", () => {
  it("lists every store once per location with unique ids and a stated path", () => {
    const ids = TELEHEALTH_RECORD_LOCATIONS.map((location) => location.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(TELEHEALTH_RECORD_LOCATIONS.map((location) => location.store))).toEqual(new Set(["telehealth_visit_record", "chart", "zoom", "backups"]));
    for (const location of TELEHEALTH_RECORD_LOCATIONS) {
      expect(location.path.length, location.id).toBeGreaterThan(8);
      for (const [name, control] of Object.entries(location.controls)) expect(control.via.length, `${location.id}.${name}`).toBeGreaterThan(12);
    }
  });

  it("covers every text location of the visit record and the chart", () => {
    for (const id of ["visit.quickNotes", "visit.flags", "visit.note.aiOriginal", "visit.note.aiSections", "visit.note.practitionerNotes", "visit.note.actionItems", "visit.noteHistory", "visit.consents", "chart.transferLedger", "chart.noteDraft", "chart.addenda"]) {
      expect(telehealthRecordLocation(id).text, id).toBe(true);
    }
    expect(() => telehealthRecordLocation("visit.somethingElse")).toThrow(/unknown telehealth record location/);
  });

  it("never claims an erasure receipt, never 'covers' a provider or backup copy, and never names a retention duration", () => {
    for (const location of TELEHEALTH_RECORD_LOCATIONS) {
      expect(location.controls.erasure.coverage, `${location.id} erasure`).not.toBe("covered");
      expect(location.controls.retention.coverage, `${location.id} retention`).not.toBe("covered");
      expect(location.controls.retention.via, `${location.id} retention`).not.toMatch(/\b\d+\s*(day|month|year|hour)s?\b/i);
      if (location.store === "zoom" || location.store === "backups") {
        expect(location.controls.erasure.coverage, `${location.id} erasure`).toBe("not_covered");
        expect(location.controls.hold.coverage, `${location.id} hold`).toBe("not_covered");
      }
    }
  });

  it("keeps owner correction and clinician amendment apart: amendment reaches only the chart's append-only addendum", () => {
    for (const location of TELEHEALTH_RECORD_LOCATIONS) {
      const amendment = location.controls.amendment;
      if (amendment.coverage === "covered") expect(amendment.via, location.id).toMatch(/add_note_addendum|append-only/);
      expect(amendment.via, location.id).not.toMatch(/owner request|rewrite/);
    }
  });
});
