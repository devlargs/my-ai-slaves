import { formatLocalIso, type SavedPrompt } from "@my-ai-slaves/shared";
import type { DataStores } from "../storage/data-stores";
import { badRequest, conflict, notFound, slugify } from "./common";

/** The saved prompt library in `.data/prompts.json`. */
export class PromptLibrary {
  constructor(
    private readonly stores: DataStores,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(): Promise<SavedPrompt[]> {
    return (await this.stores.prompts.read()).prompts;
  }

  async create(name: string, body: string): Promise<SavedPrompt> {
    const trimmed = name.trim();
    if (!trimmed) throw badRequest("Give the prompt a name.");
    const prompts = await this.list();
    if (prompts.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      throw conflict(`A prompt named "${trimmed}" already exists.`);
    }
    const base = slugify(trimmed, 60) || "prompt";
    let id = base;
    for (let n = 2; prompts.some((p) => p.id === id); n++) id = `${base}-${n}`;
    const stamp = formatLocalIso(this.now());
    const prompt: SavedPrompt = { id, name: trimmed, body, createdAt: stamp, updatedAt: stamp };
    await this.stores.prompts.update((file) => {
      file.prompts.push(prompt);
    });
    return prompt;
  }

  async update(id: string, patch: { name?: string; body?: string }): Promise<SavedPrompt> {
    const name = patch.name?.trim();
    if (patch.name !== undefined && !name) throw badRequest("Give the prompt a name.");
    const others = (await this.list()).filter((p) => p.id !== id);
    if (name && others.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw conflict(`A prompt named "${name}" already exists.`);
    }
    let updated: SavedPrompt | undefined;
    await this.stores.prompts.update((file) => {
      updated = file.prompts.find((p) => p.id === id);
      if (!updated) throw notFound(`No saved prompt "${id}".`);
      if (name) updated.name = name; // the id stays, so tasks that bound it keep working
      if (patch.body !== undefined) updated.body = patch.body;
      updated.updatedAt = formatLocalIso(this.now());
    });
    return updated as SavedPrompt;
  }

  async remove(id: string): Promise<void> {
    await this.stores.prompts.update((file) => {
      if (!file.prompts.some((p) => p.id === id)) throw notFound(`No saved prompt "${id}".`);
      file.prompts = file.prompts.filter((p) => p.id !== id);
    });
  }

  async reorder(ids: string[]): Promise<void> {
    await this.stores.prompts.update((file) => {
      const rank = new Map(ids.map((id, i) => [id, i]));
      file.prompts.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    });
  }

  /** Validate ids when a task is queued; unknown ids are an error. Returns them in library order. */
  async validate(ids: string[] | undefined): Promise<string[]> {
    const wanted = new Set(ids ?? []);
    if (wanted.size === 0) return [];
    const library = await this.list();
    const missing = [...wanted].filter((id) => !library.some((p) => p.id === id));
    if (missing.length) throw badRequest(`Unknown saved prompt(s): ${missing.join(", ")}. Reload and pick again.`);
    return library.filter((p) => wanted.has(p.id)).map((p) => p.id);
  }

  /** The current text of bound prompts, in library order, at run time. Deleted ones are reported, not sent. */
  async resolve(ids: string[]): Promise<{ prompts: SavedPrompt[]; missing: string[] }> {
    const wanted = new Set(ids);
    const library = await this.list();
    return {
      prompts: library.filter((p) => wanted.has(p.id)),
      missing: ids.filter((id) => !library.some((p) => p.id === id)),
    };
  }
}
