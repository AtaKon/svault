import { Router } from "express";
import { hashToken } from "../auth.js";
import { all, get, now, parseJson, run } from "../db.js";
import { handler } from "../http.js";
import { limiters, limitRequests } from "../rate-limit.js";

export const calendarRoutes = Router();
const escapeText = (value: unknown) => String(value ?? "").replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
// RFC 5545 limits physical lines to 75 octets, including the continuation space.
function fold(line: string): string {
  const lines: string[] = [];
  let part = "";
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    if (bytes + size > 75) { lines.push(part); part = " "; bytes = 1; }
    part += char; bytes += size;
  }
  lines.push(part);
  return lines.join("\r\n");
}
const stamp = (value: string) => {
  const date = new Date(value);
  return (Number.isNaN(date.getTime()) ? new Date(0) : date).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
};
const times: Record<string, [string, string]> = { breakfast: ["080000", "083000"], lunch: ["130000", "133000"], dinner: ["193000", "200000"], snack: ["160000", "163000"] };
calendarRoutes.get("/:token.ics", limitRequests(limiters.calendar), handler(async (req, res) => {
  const row = await get<any>("SELECT * FROM calendar_feeds WHERE token_hash = ?", [hashToken(String(req.params.token))]);
  if (!row) { res.sendStatus(404); return; }
  const selected = row.house_ids == null ? null : new Set(parseJson<string[]>(row.house_ids, []));
  const houses = (await all<{ house_id: string }>("SELECT house_id FROM house_members WHERE user_id = ?", [row.user_id])).filter((h) => !selected || selected.has(h.house_id));
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SVault//Calendar Feed//EN", "CALSCALE:GREGORIAN"];
  for (const house of houses) {
    if (row.include_plan) {
      const entries = await all<any>(`SELECT m.*, r.title AS recipe_title, i.result AS idea_result FROM meal_plan_entries m LEFT JOIN recipes r ON r.id = m.recipe_id LEFT JOIN food_ideas i ON i.id = m.idea_id WHERE m.house_id = ?`, [house.house_id]);
      for (const entry of entries) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) continue;
        const day = entry.day.replace(/-/g, "");
        const [start, end] = times[entry.slot] ?? times.dinner;
        const idea = parseJson<{ ideas?: { title?: string }[] }>(entry.idea_result, {});
        const title = entry.recipe_title ?? idea.ideas?.[entry.idea_index ?? 0]?.title ?? entry.title ?? "Planned meal";
        lines.push("BEGIN:VEVENT", `UID:plan-${entry.id}@svault`, `DTSTAMP:${stamp(entry.created_at)}`, `DTSTART:${day}T${start}`, `DTEND:${day}T${end}`, `SUMMARY:${escapeText(title)}`, "END:VEVENT");
      }
    }
    if (row.include_bills) {
      const bills = await all<any>("SELECT id, name, amount, currency, due_date, created_at FROM bills WHERE house_id = ? AND due_date IS NOT NULL", [house.house_id]);
      for (const bill of bills) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(bill.due_date)) continue;
        lines.push("BEGIN:VEVENT", `UID:bill-${bill.id}@svault`, `DTSTAMP:${stamp(bill.created_at)}`, `DTSTART;VALUE=DATE:${bill.due_date.replace(/-/g, "")}`, `SUMMARY:${escapeText(`${bill.name} - ${Number(bill.amount).toFixed(2)} ${bill.currency}`)}`, "END:VEVENT");
      }
    }
  }
  lines.push("END:VCALENDAR");
  await run("UPDATE calendar_feeds SET last_used_at = ? WHERE id = ?", [now(), row.id]);
  res.set("Content-Type", "text/calendar; charset=utf-8").set("Cache-Control", "private, max-age=300").send(lines.map(fold).join("\r\n") + "\r\n");
}));
