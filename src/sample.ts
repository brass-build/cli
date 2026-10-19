// `brass contents --from`: list the documents a set of references reaches,
// each read whole without the types an app chose it under, and tally what their streams hold by
// record type. Pure, so the listing's wire spelling, the choice of which
// documents to read, and the tally are testable without a network or the
// CRDT engine; the reads themselves are the `--doc` join, in commands.ts.

import type { DocumentWorkStatus } from './api.js';

/** The terms `GET /documents` takes. */
export interface DocumentSetQuery {
  // References as the wire spells them: `organization:<id>`, `project:<id>`,
  // `document:<id>`.
  from: string[];
  families?: string[];
}

/** A row of the listing, as much of it as the sample reports. */
export interface DocumentSetListing {
  doc_id: string;
  organization_id: string;
  project_id: string | null;
  name: string;
  updated_at: string;
  last_activity_at: string;
  schema_type?: string;
  file_type?: string;
  status?: DocumentWorkStatus;
  // The folder or archive the document sits in, and its path inside it.
  member_of?: { doc_id: string; path: string };
}

const REF_KINDS = ['organization', 'project', 'document'] as const;

/**
 * Validate `--from` values. The api drops a reference naming a kind it does
 * not know, and a query left with none answers with every document the
 * person can see, so a typo here would widen the sample rather than fail.
 */
export function parseRefs(values: readonly string[]): string[] {
  const refs: string[] = [];
  for (const value of values) {
    for (const token of value.split(',').map((t) => t.trim()).filter((t) => t !== '')) {
      const cut = token.indexOf(':');
      const kind = cut > 0 ? token.slice(0, cut) : '';
      const id = cut > 0 ? token.slice(cut + 1).trim() : '';
      if (!(REF_KINDS as readonly string[]).includes(kind) || id === '') {
        throw new Error(
          `Invalid --from "${token}" (expected organization:<id>, project:<id>, or document:<id>)`,
        );
      }
      refs.push(`${kind}:${id}`);
    }
  }
  if (refs.length === 0) {
    throw new Error('--from needs at least one organization:<id>, project:<id>, or document:<id>');
  }
  return refs;
}

/** The listing request, with the same parameters the SDK's `documents.list` sends. */
export function documentSetListPath(query: DocumentSetQuery): string {
  const params = new URLSearchParams();
  params.set('refs', JSON.stringify(query.from.map((ref) => ({ ref }))));
  if (query.families?.length) params.set('type', query.families.join(','));
  return `/documents?${params.toString()}`;
}

/** What a document is, for grouping: its own type, else its file's. */
function documentKind(doc: Pick<DocumentSetListing, 'schema_type' | 'file_type'>): string {
  return doc.schema_type ?? doc.file_type ?? '(none)';
}

/**
 * The documents to read when more match than the sample reads: one of each
 * kind in turn, keeping the listing's order (most recently worked on first)
 * within a kind. A folder of 190 models and 10 drawings then samples the
 * drawings too, where the first N of the listing could hold none.
 */
export function pickDocuments<T extends Pick<DocumentSetListing, 'schema_type' | 'file_type'>>(
  listing: readonly T[],
  count: number,
): T[] {
  const byKind = new Map<string, T[]>();
  for (const doc of listing) {
    const kind = documentKind(doc);
    const group = byKind.get(kind);
    if (group) group.push(doc);
    else byKind.set(kind, [doc]);
  }
  const groups = [...byKind.values()];
  const picked: T[] = [];
  for (let round = 0; picked.length < count; round += 1) {
    let took = false;
    for (const group of groups) {
      const doc = group[round];
      if (doc === undefined) continue;
      took = true;
      picked.push(doc);
      if (picked.length === count) break;
    }
    if (!took) break;
  }
  return picked;
}

/** The type a record carries, or null for a value that carries none. */
export type RecordTagOf = (value: unknown) => string | null;

/** Counted under this name when a record carries no type. */
export const UNTYPED = '(untyped)';

export interface SampledRecord {
  doc_id: string;
  // The record's key in a map root, or its index in a list root.
  key: string | number;
  value: unknown;
}

export interface TypeTally {
  records: number;
  // How many of the documents read carry this type in this root.
  documents: number;
  samples: SampledRecord[];
}

export interface RootTally {
  kind: 'map' | 'list' | 'text' | 'other';
  records: number;
  documents: number;
  types: Record<string, TypeTally>;
}

export interface StreamTally {
  documents: number;
  // One entry per distinct schema body, naming the documents that carry it,
  // so a population whose documents disagree says so. A document whose
  // stream has no published schema is counted under `unpublished`.
  schemas: { doc_ids: string[]; schema: Record<string, unknown> }[];
  unpublished: string[];
  roots: Record<string, RootTally>;
}

interface TypeAccumulator {
  records: number;
  docIds: Set<string>;
  // Candidate samples, at most `samplesPerType` from any one document, so the
  // final pick can spread over documents without holding every record.
  byDoc: Map<string, SampledRecord[]>;
}

interface RootAccumulator {
  kind: RootTally['kind'];
  records: number;
  docIds: Set<string>;
  types: Map<string, TypeAccumulator>;
}

interface StreamAccumulator {
  docIds: Set<string>;
  schemas: { doc_ids: string[]; key: string; schema: Record<string, unknown> }[];
  unpublished: string[];
  roots: Map<string, RootAccumulator>;
}

/**
 * A running tally over the streams of many documents, by stream, root, and
 * record type. Each document's contents are folded in as they are read and
 * then dropped, so the sample holds only its counts and its candidate
 * records rather than every document at once.
 */
export class SampleTally {
  private readonly streams = new Map<string, StreamAccumulator>();

  constructor(
    private readonly tagOf: RecordTagOf,
    private readonly samplesPerType: number,
  ) {}

  add(
    docId: string,
    stream: string,
    schema: Record<string, unknown> | undefined,
    contents: Record<string, unknown>,
  ): void {
    let acc = this.streams.get(stream);
    if (!acc) {
      acc = { docIds: new Set(), schemas: [], unpublished: [], roots: new Map() };
      this.streams.set(stream, acc);
    }
    acc.docIds.add(docId);
    if (schema === undefined) {
      acc.unpublished.push(docId);
    } else {
      const key = stableStringify(schema);
      const held = acc.schemas.find((s) => s.key === key);
      if (held) held.doc_ids.push(docId);
      else acc.schemas.push({ doc_ids: [docId], key, schema });
    }
    for (const [name, value] of Object.entries(contents)) {
      this.addRoot(acc, docId, name, value);
    }
  }

  private addRoot(acc: StreamAccumulator, docId: string, name: string, value: unknown): void {
    const kind: RootTally['kind'] =
      typeof value === 'string'
        ? 'text'
        : Array.isArray(value)
          ? 'list'
          : value !== null && typeof value === 'object'
            ? 'map'
            : 'other';
    let root = acc.roots.get(name);
    if (!root) {
      root = { kind, records: 0, docIds: new Set(), types: new Map() };
      acc.roots.set(name, root);
    }
    root.docIds.add(docId);
    if (kind === 'text' || kind === 'other') {
      root.records += 1;
      this.addRecord(root, docId, UNTYPED, '', value);
      return;
    }
    const entries: [string | number, unknown][] =
      kind === 'list'
        ? (value as unknown[]).map((item, index) => [index, item])
        : Object.entries(value as Record<string, unknown>);
    for (const [key, record] of entries) {
      root.records += 1;
      this.addRecord(root, docId, this.tagOf(record) ?? UNTYPED, key, record);
    }
  }

  private addRecord(
    root: RootAccumulator,
    docId: string,
    tag: string,
    key: string | number,
    value: unknown,
  ): void {
    let type = root.types.get(tag);
    if (!type) {
      type = { records: 0, docIds: new Set(), byDoc: new Map() };
      root.types.set(tag, type);
    }
    type.records += 1;
    type.docIds.add(docId);
    let held = type.byDoc.get(docId);
    if (!held) {
      held = [];
      type.byDoc.set(docId, held);
    }
    if (held.length < this.samplesPerType) held.push({ doc_id: docId, key, value });
  }

  toJSON(): Record<string, StreamTally> {
    const out: Record<string, StreamTally> = {};
    for (const [stream, acc] of this.streams) {
      const roots: Record<string, RootTally> = {};
      for (const [name, root] of acc.roots) {
        const types: Record<string, TypeTally> = {};
        // Most records first, so the types that dominate a population read first.
        const ordered = [...root.types.entries()].sort((a, b) => b[1].records - a[1].records);
        for (const [tag, type] of ordered) {
          types[tag] = {
            records: type.records,
            documents: type.docIds.size,
            samples: spreadSamples(type.byDoc, this.samplesPerType),
          };
        }
        roots[name] = {
          kind: root.kind,
          records: root.records,
          documents: root.docIds.size,
          types,
        };
      }
      out[stream] = {
        documents: acc.docIds.size,
        schemas: acc.schemas.map(({ doc_ids, schema }) => ({ doc_ids, schema })),
        unpublished: acc.unpublished,
        roots,
      };
    }
    return out;
  }
}

// One sample from each document in turn before a second from any, so the
// samples show how the type varies across the population rather than within
// one file.
function spreadSamples(
  byDoc: ReadonlyMap<string, SampledRecord[]>,
  count: number,
): SampledRecord[] {
  const groups = [...byDoc.values()];
  const out: SampledRecord[] = [];
  for (let round = 0; out.length < count; round += 1) {
    let took = false;
    for (const group of groups) {
      const record = group[round];
      if (record === undefined) continue;
      took = true;
      out.push(record);
      if (out.length === count) break;
    }
    if (!took) break;
  }
  return out;
}

// Key order is the writer's choice, so two documents carrying the same schema
// can serialise it differently; comparing sorted keys counts them as one.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
