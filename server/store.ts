import { mkdir, readFile, rename, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { defaults, type Settings, type Stream } from "./engine.js";
export interface SavedState {
  version: 1;
  activeStreamId?: string;
  settings: Settings;
  mockOffset: number;
}
export const validId = (id: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(id);
export class Store {
  readonly root: string;
  private savedListeners = new Set<() => void>();
  onStreamSaved(listener: () => void) {
    this.savedListeners.add(listener);
    return () => {
      this.savedListeners.delete(listener);
    };
  }
  constructor(root = resolve("data")) {
    this.root = root;
  }
  async init() {
    await mkdir(join(this.root, "streams"), { recursive: true });
    await mkdir(join(this.root, "cards"), { recursive: true });
  }
  streamPath(id: string) {
    if (!validId(id)) throw new Error("Invalid stream ID");
    return join(this.root, "streams", `${id}.json`);
  }
  pngPath(id: string) {
    if (!validId(id)) throw new Error("Invalid stream ID");
    return join(this.root, "cards", `${id}.png`);
  }
  private async json<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private async atomic(file: string, value: unknown) {
    await writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
    await rename(file + ".tmp", file);
  }
  async state(): Promise<SavedState> {
    return (
      (await this.json<SavedState>(join(this.root, "state.json"))) ?? {
        version: 1,
        settings: { ...defaults },
        mockOffset: 0,
      }
    );
  }
  async saveState(state: SavedState) {
    await this.atomic(join(this.root, "state.json"), state);
  }
  async stream(id: string) {
    return this.json<Stream>(this.streamPath(id));
  }
  async saveStream(stream: Stream) {
    await this.atomic(this.streamPath(stream.id), stream);
    for (const listener of this.savedListeners) listener();
  }
  async streams() {
    const files = (await readdir(join(this.root, "streams"))).filter((name) =>
      /^[\w-]+\.json$/.test(name),
    );
    const streams = await Promise.all(
      files.map((name) => this.stream(name.slice(0, -5))),
    );
    return streams
      .filter((s): s is Stream => !!s)
      .sort((a, b) => b.startedAt - a.startedAt);
  }
}
