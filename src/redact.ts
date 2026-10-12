/**
 * Keeps credentials out of everything the server returns to the model (tool results and errors):
 * configured secrets (tokens, passwords, keys), the userinfo of URLs, bearer tokens, and the value of any field whose name says
 * "password", "secret", "token", "api key", …
 */
const SECRET_NAME = /pass(word|wd)?|secret|token|api[-_ ]?key|authorization|credential/i;
const MASK = "***";

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Array<string | undefined>) {
    this.secrets = secrets.filter((s): s is string => !!s && s.length >= 3).sort((a, b) => b.length - a.length);
  }

  str(s: string): string {
    let out = s.replace(/(\bhttps?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`).replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${MASK}`);
    for (const secret of this.secrets) out = out.split(secret).join(MASK);
    return out;
  }

  /** Deep copy of `v` with secrets masked. */
  value<T>(v: T): T {
    return this.walk(v) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === "string") return this.str(v);
    if (Array.isArray(v)) {
      // Form fields are {name, value} pairs: mask by field name.
      return v.map((x) => {
        if (x && typeof x === "object" && "name" in x && "value" in x && typeof (x as { name: unknown }).name === "string" && SECRET_NAME.test((x as { name: string }).name)) {
          return { ...(x as object), value: MASK };
        }
        return this.walk(x);
      });
    }
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, SECRET_NAME.test(k) && typeof val === "string" ? MASK : this.walk(val)]));
    }
    return v;
  }
}
