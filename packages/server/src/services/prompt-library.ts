import { formatLocalIso, type RepoPrompt, type SavedPrompt } from "@my-ai-slaves/shared";
import type { DataStores } from "../storage/data-stores";
import { badRequest, conflict, notFound, slugify } from "./common";

/** Where a prompt list lives: read it, or change it in place (one atomic file write). */
export interface PromptListIo<T extends SavedPrompt> {
  read(): Promise<T[]>;
  update(change: (list: T[]) => void): Promise<unknown>;
}

/** Fields a list adds on top of name + body (e.g. a repo prompt's `default`). */
type Extra<T extends SavedPrompt> = Partial<Omit<T, keyof SavedPrompt>>;

/**
 * An ordered list of named prompts, sent verbatim when bound. Used for the saved prompt library
 * (`.data/prompts.json`) and for each repo's prompts (`.data/knowledge/<repo>.json`).
 */
export class PromptList<T extends SavedPrompt = SavedPrompt> {
  constructor(
    private readonly io: PromptListIo<T>,
    /** "saved prompt" / "repo prompt": used in error messages. */
    private readonly noun: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  list(): Promise<T[]> {
    return this.io.read();
  }

  async create(name: string, body: string, extra: Extra<T> = {}): Promise<T> {
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
    const prompt = { ...extra, id, name: trimmed, body, createdAt: stamp, updatedAt: stamp } as T;
    await this.io.update((list) => {
      list.push(prompt);
    });
    return prompt;
  }

  async update(id: string, patch: { name?: string; body?: string } & Extra<T>): Promise<T> {
    const { name: rawName, body, ...extra } = patch;
    const name = rawName?.trim();
    if (rawName !== undefined && !name) throw badRequest("Give the prompt a name.");
    const others = (await this.list()).filter((p) => p.id !== id);
    if (name && others.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw conflict(`A prompt named "${name}" already exists.`);
    }
    let updated: T | undefined;
    await this.io.update((list) => {
      updated = list.find((p) => p.id === id);
      if (!updated) throw notFound(`No ${this.noun} "${id}".`);
      if (name) updated.name = name; // the id stays, so tasks that bound it keep working
      if (body !== undefined) updated.body = body;
      for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) (updated as Record<string, unknown>)[key] = value;
      }
      updated.updatedAt = formatLocalIso(this.now());
    });
    return updated as T;
  }

  async remove(id: string): Promise<void> {
    await this.io.update((list) => {
      const at = list.findIndex((p) => p.id === id);
      if (at < 0) throw notFound(`No ${this.noun} "${id}".`);
      list.splice(at, 1);
    });
  }

  async reorder(ids: string[]): Promise<void> {
    await this.io.update((list) => {
      const rank = new Map(ids.map((id, i) => [id, i]));
      list.sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
    });
  }

  /** Validate ids when a task is queued; unknown ids are an error. Returns them in list order. */
  async validate(ids: string[] | undefined): Promise<string[]> {
    const wanted = new Set(ids ?? []);
    if (wanted.size === 0) return [];
    const list = await this.list();
    const missing = [...wanted].filter((id) => !list.some((p) => p.id === id));
    if (missing.length) throw badRequest(`Unknown ${this.noun}(s): ${missing.join(", ")}. Reload and pick again.`);
    return list.filter((p) => wanted.has(p.id)).map((p) => p.id);
  }

  /** The current text of bound prompts, in list order, at run time. Deleted ones are reported, not sent. */
  async resolve(ids: string[]): Promise<{ prompts: T[]; missing: string[] }> {
    const wanted = new Set(ids);
    const list = await this.list();
    return {
      prompts: list.filter((p) => wanted.has(p.id)),
      missing: ids.filter((id) => !list.some((p) => p.id === id)),
    };
  }
}

/** The saved prompt library in `.data/prompts.json`. */
export class PromptLibrary extends PromptList<SavedPrompt> {
  constructor(stores: DataStores, now: () => Date = () => new Date()) {
    super(
      {
        read: async () => (await stores.prompts.read()).prompts,
        update: (change) => stores.prompts.update((file) => change(file.prompts)),
      },
      "saved prompt",
      now,
    );
  }
}

/** One repo's prompts in `.data/knowledge/<repo>.json`. */
export class RepoPromptList extends PromptList<RepoPrompt> {
  constructor(stores: DataStores, repo: string, now: () => Date = () => new Date()) {
    const store = stores.knowledge(repo);
    super(
      {
        read: async () => (await store.read()).prompts,
        update: (change) =>
          store.update((file) => {
            change(file.prompts);
            file.updatedAt = formatLocalIso(now());
          }),
      },
      "repo prompt",
      now,
    );
  }

  /** What a task sends when you didn't pick: the prompts marked default. */
  async defaultIds(): Promise<string[]> {
    return (await this.list()).filter((p) => p.default).map((p) => p.id);
  }
}
