import * as cheerio from "cheerio";

/**
 * The admin forms of collectory, read from the live page.
 *
 * Writes that have no web service go through the same forms a person uses. Each write first reads the live form and
 * posts back every field it has (hidden ids, version for optimistic locking, current values), changing only the
 * fields asked for. A field the form does not have is refused: if a new collectory release renames it, nothing is
 * sent (fail closed), instead of posting something the server silently ignores.
 */
export interface Form {
  action: string;
  method: string;
  /** Field values in document order; a name can repeat (multi-selects, checkbox lists). */
  fields: Array<[string, string]>;
  /** Names of every input, select and textarea, posted or not (unchecked checkboxes, submit buttons). */
  names: Set<string>;
  /** Submit buttons by name, e.g. Grails' "_action_updateDescription". */
  submits: Map<string, string>;
}

export class FormContractError extends Error {}

/** The first form whose action matches or which has a submit button with that name. */
export function findForm(html: string, pageUrl: string, match: { action?: RegExp; submit?: string; hasField?: string }): Form {
  const $ = cheerio.load(html);
  const forms = $("form").toArray();
  for (const f of forms) {
    const $f = $(f);
    const action = new URL($f.attr("action") || pageUrl, pageUrl).toString();
    if (match.action && !match.action.test(new URL(action).pathname)) continue;
    if (match.submit && !$f.find(`[name="${match.submit}"]`).length) continue;
    if (match.hasField && !$f.find(`[name="${match.hasField}"]`).length) continue;
    return parseForm($, $f, action);
  }
  const what = [match.action && `action ${match.action}`, match.submit && `button ${match.submit}`, match.hasField && `field ${match.hasField}`].filter(Boolean).join(", ");
  throw new FormContractError(`the page ${new URL(pageUrl).pathname} has no form with ${what}: the collectory admin UI may have changed (nothing was sent)`);
}

function parseForm($: cheerio.CheerioAPI, $f: cheerio.Cheerio<any>, action: string): Form {
  const fields: Array<[string, string]> = [];
  const names = new Set<string>();
  const submits = new Map<string, string>();
  $f.find("input[name], select[name], textarea[name]").each((_, el) => {
    const $el = $(el);
    const name = $el.attr("name")!;
    names.add(name);
    if ($el.attr("disabled") !== undefined) return;
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag === "select") {
      const selected = $el.find("option[selected]").toArray();
      const opts = selected.length ? selected : $el.attr("multiple") !== undefined ? [] : $el.find("option").first().toArray();
      for (const o of opts) fields.push([name, $(o).attr("value") ?? $(o).text()]);
      return;
    }
    if (tag === "textarea") {
      fields.push([name, $el.text()]);
      return;
    }
    const type = ($el.attr("type") ?? "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "image") {
      submits.set(name, $el.attr("value") ?? "");
      return;
    }
    if ((type === "checkbox" || type === "radio") && $el.attr("checked") === undefined) return;
    fields.push([name, $el.attr("value") ?? (type === "checkbox" ? "on" : "")]);
  });
  return { action, method: ($f.attr("method") ?? "get").toUpperCase(), fields, names, submits };
}

/**
 * Body for posting `form` with `changes` applied. A change to a field the form does not have is refused.
 * A value of `undefined` removes the field (an unticked checkbox); an array sets a repeated field.
 */
export function fill(form: Form, changes: Record<string, string | string[] | boolean | undefined>, submit?: string): URLSearchParams {
  const unknown = Object.keys(changes).filter((k) => !form.names.has(k));
  if (unknown.length) throw new FormContractError(`the form ${new URL(form.action).pathname} has no field ${unknown.join(", ")}: the collectory admin UI may have changed (nothing was sent)`);
  if (submit && !form.submits.has(submit)) throw new FormContractError(`the form ${new URL(form.action).pathname} has no button ${submit} (nothing was sent)`);
  const out: Array<[string, string]> = form.fields.filter(([n]) => !(n in changes));
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || v === false) continue;
    if (v === true) out.push([k, "on"]);
    else if (Array.isArray(v)) for (const x of v) out.push([k, x]);
    else out.push([k, v]);
  }
  if (submit) out.push([submit, form.submits.get(submit) ?? ""]);
  return new URLSearchParams(out);
}

/** Flash / error messages a Grails page shows after a redirect. */
export function pageMessages(html: string): { messages: string[]; errors: string[] } {
  const $ = cheerio.load(html);
  const text = (sel: string) =>
    $(sel)
      .toArray()
      .map((e) => $(e).text().replace(/\s+/g, " ").trim())
      .filter(Boolean);
  return { messages: [...new Set(text(".message, .alert-info, .alert-success, .alert-warning"))], errors: [...new Set(text(".errors li, .alert-danger, .error"))] };
}

/** Rows of the first table with a header, keyed by header text. */
export function htmlTable(html: string): Array<Record<string, string>> {
  const $ = cheerio.load(html);
  const table = $("table").filter((_, t) => $(t).find("th").length > 0).first();
  const heads = table.find("th").toArray().map((th, i) => $(th).text().replace(/\s+/g, " ").trim() || `col${i}`);
  const rows: Array<Record<string, string>> = [];
  for (const tr of table.find("tbody tr").toArray()) {
    const row: Record<string, string> = {};
    $(tr)
      .find("td")
      .toArray()
      .forEach((td, i) => (row[heads[i] ?? `col${i}`] = $(td).text().replace(/\s+/g, " ").trim()));
    if (Object.values(row).some(Boolean)) rows.push(row);
  }
  return rows;
}
