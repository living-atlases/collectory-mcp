import { openAsBlob, statSync } from "node:fs";

import { type CollectoryClient, entityOf } from "./collectory-client.ts";
import { fill, findForm } from "./forms.ts";

type Json = Record<string, unknown>;

/** collectory limits the image to 200 KB (ProviderGroupController.updateImages). */
const LIMIT = 200_000;

export interface ImageInput {
  uid: string;
  /** The image file on this machine; omit to only change the caption/attribution/copyright of the current one. */
  file?: string;
  /** imageRef (the entity's image) or logoRef (its logo). */
  target?: "imageRef" | "logoRef";
  caption?: string;
  attribution?: string;
  copyright?: string;
}

/**
 * Upload an image or logo to an entity through the admin form (`/{entity}/image`, multipart), or change its metadata.
 * There is no web service for the file; the web service does write the imageRef/logoRef metadata, but not the bytes.
 * collectory only strips non-Latin-1 characters from the filename (it does not use UploadPathHelper.sanitizeFilename,
 * unlike the data upload, #272), so the name is sanitised here and path separators are refused before sending.
 */
export class ImageUpload {
  constructor(readonly client: CollectoryClient) {}

  /** A safe stored filename: base name only, Latin-1, no separators (what collectory should do but does not). */
  static safeName(path: string): string {
    const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
    const clean = base.replace(/[^ -ÿ]/g, "_").replace(/^\.+/, "_").trim();
    if (!clean || clean === "_") throw new Error(`cannot derive a safe filename from "${base}"`);
    return clean;
  }

  async plan(input: ImageInput) {
    const e = entityOf(input.uid);
    const target = input.target ?? "imageRef";
    const pg = await this.client.get<Json>(input.uid, e);
    const current = (pg[target] as Json | undefined) ?? null;
    const errors: string[] = [];
    let file: { path: string; name: string; size: number } | undefined;
    if (input.file) {
      const st = statSync(input.file);
      const name = ImageUpload.safeName(input.file);
      file = { path: input.file, name, size: st.size };
      if (st.size >= LIMIT) errors.push(`${(st.size / 1024).toFixed(0)} KB: collectory limits images to 200 KB and would reject this one`);
    } else if (!input.caption && input.attribution === undefined && input.copyright === undefined) {
      errors.push("give a file to upload, or a caption/attribution/copyright to change");
    } else if (!current) {
      errors.push(`${input.uid} has no ${target} yet: give a file`);
    }
    const metadata = { caption: input.caption, attribution: input.attribution, copyright: input.copyright };
    return {
      uid: input.uid,
      name: pg["name"],
      target,
      current,
      ...(file ? { file: { name: file.name, size: file.size } } : {}),
      metadata: Object.fromEntries(Object.entries(metadata).filter(([, v]) => v !== undefined)),
      errors,
      _file: file,
    };
  }

  async upload(input: ImageInput) {
    const plan = await this.plan(input);
    if (plan.errors.length) throw new Error(plan.errors.join("; "));
    const e = entityOf(input.uid);
    const { url, html } = await this.client.page(`/${e}/edit/${input.uid}?page=/shared/images&target=${plan.target}`);
    const form = findForm(html, url, { submit: "_action_updateImages" });
    const changes: Record<string, string> = {};
    for (const [k, v] of [["caption", input.caption], ["attribution", input.attribution], ["copyright", input.copyright]] as const) {
      if (v !== undefined) changes[`${plan.target}.${k}`] = v;
    }
    const fileField = plan.target === "logoRef" ? "logoFile" : "imageFile";
    const body = fill(form, changes, "_action_updateImages");
    const fd = new FormData();
    for (const [k, v] of body) if (k !== fileField) fd.append(k, v);
    fd.append(fileField, plan._file ? await openAsBlob(plan._file.path) : new Blob([]), plan._file?.name ?? "");
    await this.client.submit(form.action, fd);
    const after = ((await this.client.get<Json>(input.uid, e))[plan.target] as Json | undefined) ?? null;
    const { _file, ...shown } = plan;
    return {
      ...shown,
      saved: true,
      now: after,
      verified: !plan._file || (!!after && String((after as Json)["filename"] ?? "") === plan._file.name),
    };
  }

  async remove(uid: string, target: "imageRef" | "logoRef") {
    const e = entityOf(uid);
    const { url, html } = await this.client.page(`/${e}/edit/${uid}?page=/shared/images&target=${target}`);
    const form = findForm(html, url, { submit: "_action_removeImage" });
    const fileField = target === "logoRef" ? "logoFile" : "imageFile";
    const body = fill(form, {}, "_action_removeImage");
    const fd = new FormData();
    for (const [k, v] of body) if (k !== fileField) fd.append(k, v);
    fd.append(fileField, new Blob([]), "");
    await this.client.submit(form.action, fd);
    const after = (await this.client.get<Json>(uid, e))[target] ?? null;
    return { uid, target, removed: after === null, now: after };
  }
}
