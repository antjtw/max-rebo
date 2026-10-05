import fs from 'node:fs';
import path from 'node:path';
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type Node as YamlNode,
} from 'yaml';
import type { z } from 'zod';
import {
  HooksFileSchema,
  PlayersFileSchema,
  ScenesFileSchema,
  SettingsSchema,
  Taxonomy,
  TriggersFileSchema,
  VocabularyFileSchema,
  type ConfigName,
  type HooksFile,
  type PlayersFile,
  type ScenesFile,
  type Settings,
  type TriggersFile,
  type VocabularyFile,
} from '@cantina/shared';

export interface ConfigValues {
  settings: Settings;
  scenes: ScenesFile;
  triggers: TriggersFile;
  players: PlayersFile;
  hooks: HooksFile;
  vocabulary: VocabularyFile;
  taxonomy: z.infer<typeof Taxonomy>;
}

const SCHEMAS: { [K in ConfigName]: z.ZodType<ConfigValues[K]> } = {
  settings: SettingsSchema as z.ZodType<Settings>,
  scenes: ScenesFileSchema as z.ZodType<ScenesFile>,
  triggers: TriggersFileSchema as z.ZodType<TriggersFile>,
  players: PlayersFileSchema as z.ZodType<PlayersFile>,
  hooks: HooksFileSchema as z.ZodType<HooksFile>,
  vocabulary: VocabularyFileSchema as z.ZodType<VocabularyFile>,
  taxonomy: Taxonomy,
};

export const CONFIG_FILES: Record<ConfigName, string> = {
  settings: 'settings.yaml',
  scenes: 'scenes.yaml',
  triggers: 'triggers.yaml',
  players: 'players.yaml',
  hooks: 'hooks.mtfbwy.yaml',
  vocabulary: 'vocabulary.yaml',
  taxonomy: 'taxonomy.yaml',
};

/** Files that may be absent: an empty document is validated instead. */
const OPTIONAL: ReadonlySet<ConfigName> = new Set(['players', 'vocabulary', 'taxonomy', 'hooks']);

export interface ConfigIssue {
  path: string;
  line: number | null;
  column: number | null;
  message: string;
}

export class ConfigValidationError extends Error {
  constructor(
    readonly file: string,
    readonly issues: ConfigIssue[],
  ) {
    super(
      `${file} is invalid:\n` +
        issues
          .map(
            (i) =>
              `  ${i.line != null ? `line ${i.line}: ` : ''}${i.path ? i.path + ': ' : ''}${i.message}`,
          )
          .join('\n'),
    );
    this.name = 'ConfigValidationError';
  }
}

export type ValidationResult<T> =
  { ok: true; value: T; doc: Document } | { ok: false; issues: ConfigIssue[] };

/** Parse and validate YAML text, mapping schema errors back to line numbers. */
export function validateYaml<K extends ConfigName>(
  name: K,
  text: string,
): ValidationResult<ConfigValues[K]> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: false });
  if (doc.errors.length) {
    return {
      ok: false,
      issues: doc.errors.map((e) => ({
        path: '',
        line: e.linePos?.[0]?.line ?? null,
        column: e.linePos?.[0]?.col ?? null,
        message: e.message.split('\n')[0] ?? e.message,
      })),
    };
  }
  const raw = doc.toJS() ?? {};
  const result = SCHEMAS[name].safeParse(raw);
  if (result.success) return { ok: true, value: result.data, doc };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const p = issue.path.map((x) => (typeof x === 'symbol' ? String(x) : x));
      const pos = locate(doc, p, lineCounter);
      return {
        path: p.join('.'),
        line: pos?.line ?? null,
        column: pos?.col ?? null,
        message: issue.message,
      };
    }),
  };
}

function locate(
  doc: Document,
  p: (string | number)[],
  lc: LineCounter,
): { line: number; col: number } | null {
  // Walk up the path until a node with a source range is found.
  for (let n = p.length; n >= 0; n--) {
    const node = (n === 0 ? doc.contents : doc.getIn(p.slice(0, n), true)) as YamlNode | undefined;
    if (node && node.range) return lc.linePos(node.range[0]);
  }
  return null;
}

/**
 * Apply `value` onto an existing YAML document node by node, so comments and formatting on
 * untouched keys survive a write from the dashboard (SPEC §9.5).
 */
export function applyToDocument(doc: Document, value: unknown): void {
  if (!doc.contents) {
    doc.contents = doc.createNode(value) as unknown as typeof doc.contents;
    return;
  }
  doc.contents = merge(doc, doc.contents as YamlNode, value) as unknown as typeof doc.contents;
}

function merge(doc: Document, node: YamlNode | null | undefined, value: unknown): YamlNode {
  if (node && isMap(node) && isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    for (const pair of [...node.items]) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      if (!(key in obj)) node.delete(pair.key);
    }
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const existing = node.get(k, true) as YamlNode | undefined;
      node.set(k, merge(doc, existing, v));
    }
    return node;
  }
  if (node && isSeq(node) && Array.isArray(value)) {
    const byId = new Map<string, YamlNode>();
    for (const item of node.items) {
      if (isMap(item)) {
        const id = item.get('id');
        if (typeof id === 'string') byId.set(id, item);
      }
    }
    const allHaveIds = value.every(
      (v) => isPlainObject(v) && typeof (v as { id?: unknown }).id === 'string',
    );
    if (allHaveIds && byId.size) {
      node.items = value.map((v) => merge(doc, byId.get((v as { id: string }).id), v));
      return node;
    }
    node.items = value.map((v, i) => merge(doc, node.items[i] as YamlNode | undefined, v));
    return node;
  }
  if (node && isScalar(node) && !isPlainObject(value) && !Array.isArray(value)) {
    if (node.value !== value) node.value = value;
    return node;
  }
  return doc.createNode(value) as YamlNode;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type Listener = <K extends ConfigName>(name: K, value: ConfigValues[K]) => void;

/**
 * Loads, validates, watches and writes the YAML config files. An invalid change is refused and
 * the previous config keeps running (SPEC §14).
 */
export class ConfigStore {
  private values: Partial<ConfigValues> = {};
  private texts: Partial<Record<ConfigName, string>> = {};
  private listeners = new Set<Listener>();
  private watchers: fs.FSWatcher[] = [];
  private lastErrors = new Map<ConfigName, ConfigValidationError>();
  private suppressWatchUntil = new Map<ConfigName, number>();

  constructor(readonly dir: string) {}

  filePath(name: ConfigName): string {
    return path.join(this.dir, CONFIG_FILES[name]);
  }

  /** Load every file. Throws ConfigValidationError on the first invalid file at start-up. */
  loadAll(): ConfigValues {
    for (const name of Object.keys(CONFIG_FILES) as ConfigName[]) {
      const res = this.readAndValidate(name);
      if (!res.ok) throw new ConfigValidationError(CONFIG_FILES[name], res.issues);
      (this.values as Record<string, unknown>)[name] = res.value;
    }
    return this.all();
  }

  all(): ConfigValues {
    return this.values as ConfigValues;
  }

  get<K extends ConfigName>(name: K): ConfigValues[K] {
    const v = this.values[name];
    if (v === undefined) throw new Error(`config ${name} not loaded`);
    return v as ConfigValues[K];
  }

  text(name: ConfigName): string {
    return this.texts[name] ?? '';
  }

  errors(): ConfigValidationError[] {
    return [...this.lastErrors.values()];
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Validate and save raw YAML text (from the dashboard's raw editor). */
  writeText<K extends ConfigName>(name: K, text: string): ConfigValues[K] {
    const res = validateYaml(name, text);
    if (!res.ok) throw new ConfigValidationError(CONFIG_FILES[name], res.issues);
    this.persist(name, text, res.value);
    return res.value;
  }

  /** Save a structured value, preserving comments in the existing file where possible. */
  writeValue<K extends ConfigName>(name: K, value: unknown): ConfigValues[K] {
    const parsed = SCHEMAS[name].safeParse(value);
    if (!parsed.success) {
      throw new ConfigValidationError(
        CONFIG_FILES[name],
        parsed.error.issues.map((i) => ({
          path: i.path.map(String).join('.'),
          line: null,
          column: null,
          message: i.message,
        })),
      );
    }
    const doc = parseDocument(this.texts[name] ?? '');
    applyToDocument(doc, value);
    const text = doc.toString({ lineWidth: 100 });
    const res = validateYaml(name, text);
    if (!res.ok) throw new ConfigValidationError(CONFIG_FILES[name], res.issues);
    this.persist(name, text, res.value);
    return res.value;
  }

  /** Watch for hand edits. Invalid edits are reported and ignored. */
  watch(onError: (err: ConfigValidationError) => void): void {
    const byFile = new Map(
      (Object.entries(CONFIG_FILES) as [ConfigName, string][]).map(([n, f]) => [f, n]),
    );
    const timers = new Map<ConfigName, NodeJS.Timeout>();
    try {
      const w = fs.watch(this.dir, (_evt, file) => {
        const name = file ? byFile.get(file.toString()) : undefined;
        if (!name) return;
        if ((this.suppressWatchUntil.get(name) ?? 0) > Date.now()) return;
        clearTimeout(timers.get(name));
        timers.set(
          name,
          setTimeout(() => this.reload(name, onError), 150),
        );
      });
      this.watchers.push(w);
    } catch {
      // Directory watching is best effort.
    }
  }

  reload(name: ConfigName, onError?: (err: ConfigValidationError) => void): boolean {
    const res = this.readAndValidate(name);
    if (!res.ok) {
      const err = new ConfigValidationError(CONFIG_FILES[name], res.issues);
      this.lastErrors.set(name, err);
      onError?.(err);
      return false;
    }
    this.lastErrors.delete(name);
    (this.values as Record<string, unknown>)[name] = res.value;
    this.notify(name, res.value);
    return true;
  }

  close(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }

  private readAndValidate<K extends ConfigName>(name: K): ValidationResult<ConfigValues[K]> {
    const file = this.filePath(name);
    let text = '';
    if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8');
    else if (!OPTIONAL.has(name)) {
      return {
        ok: false,
        issues: [{ path: '', line: null, column: null, message: `missing file ${file}` }],
      };
    }
    const res = validateYaml(name, text);
    if (res.ok) this.texts[name] = text;
    return res;
  }

  private persist<K extends ConfigName>(name: K, text: string, value: ConfigValues[K]): void {
    const file = this.filePath(name);
    this.suppressWatchUntil.set(name, Date.now() + 1000);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    this.texts[name] = text;
    (this.values as Record<string, unknown>)[name] = value;
    this.lastErrors.delete(name);
    this.notify(name, value);
  }

  private notify<K extends ConfigName>(name: K, value: ConfigValues[K]): void {
    for (const l of [...this.listeners]) l(name, value);
  }
}
