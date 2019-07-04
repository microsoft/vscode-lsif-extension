/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as Sqlite from 'better-sqlite3';

import * as lsp from 'vscode-languageserver';

import { Database, UriTransformer } from './database';
import {
	Id, RangeBasedDocumentSymbol, Range, ReferenceResult, Moniker, MetaData
} from 'lsif-protocol';

import { DocumentInfo } from './files';
import { URI } from 'vscode-uri';

interface MetaDataResult {
	id: number;
	value: string;
}

interface LiteralMap<T> {
	[key: string]: T;
	[key: number]: T;
}

interface RangeData extends Pick<Range, 'start' | 'end' | 'tag'> {
	moniker?: Id;
	next?: Id;
	hoverResult?: Id;
	declarationResult?: Id;
	definitionResult?: Id;
	referenceResult?: Id;
}

interface ResultSetData {
	moniker?: Id;
	next?: Id;
	hoverResult?: Id;
	declarationResult?: Id;
	definitionResult?: Id;
	referenceResult?: Id;
}

interface DeclarationResultData {
	values: Id[];
}

interface DefinitionResultData {
	values: Id[];
}

interface ReferenceResultData {
	declarations?: Id[];
	definitions?: Id[];
	references?: Id[];
}

type MonikerData = Pick<Moniker, 'scheme' | 'identifier' | 'kind'>;

interface DocumentBlob {
	contents: string;
	ranges: LiteralMap<RangeData>;
	resultSets?: LiteralMap<ResultSetData>;
	monikers?: LiteralMap<MonikerData>;
	hovers?: LiteralMap<lsp.Hover>;
	declarationResults?: LiteralMap<DeclarationResultData>;
	definitionResults?: LiteralMap<DefinitionResultData>;
	referenceResults?: LiteralMap<ReferenceResultData>;
	foldingRanges?: lsp.FoldingRange[];
	documentSymbols?: lsp.DocumentSymbol[] | RangeBasedDocumentSymbol[];
	diagnostics?: lsp.Diagnostic[];
}

interface DocumentsResult {
	documentId: string;
	uri: string;
}

interface BlobResult {
	content: string;
}

interface DocumentResult {
	documentId: string;
}

export class BlobStore extends Database {

	private db!: Sqlite.Database;

	private allDocumentsStmt!: Sqlite.Statement;
	private findDocumentStmt!: Sqlite.Statement;
	private findBlobStmt!: Sqlite.Statement;

	private version: string;
	private projectRoot!: URI;
	private blobs: Map<Id, DocumentBlob>;

	public constructor() {
		super();
		this.version = 'v1';
		this.blobs = new Map();
	}

	public load(file: string, transformerFactory: (projectRoot: string) => UriTransformer): Promise<void> {
		this.db = new Sqlite(file, { readonly: true });
		this.readMetaData();
		this.allDocumentsStmt = this.db.prepare('Select d.documentId, d.uri From documents d Inner Join versions v On v.documentId = d.documentId Where v.versionId = ?');
		this.findDocumentStmt = this.db.prepare('Select d.documentId From documents d Inner Join versions v On v.documentId = d.documentId Where v.versionId = $version and d.uri = $uri');
		this.findBlobStmt = this.db.prepare('Select content From blobs Where documentId = ?')
		this.initialize(transformerFactory);
		return Promise.resolve();
	}

	private readMetaData(): void {
		let result: MetaDataResult[] = this.db.prepare('Select * from meta').all();
		if (result === undefined || result.length !== 1) {
			throw new Error('Failed to read meta data record.');
		}
		let metaData: MetaData = JSON.parse(result[0].value);
		if (metaData.projectRoot === undefined) {
			throw new Error('No project root provided.');
		}
		this.projectRoot = URI.parse(metaData.projectRoot);
	}

	public getProjectRoot(): URI {
		return this.projectRoot;
	}

	public close(): void {
		this.db.close();
	}

	protected getDocumentInfos(): DocumentInfo[] {
		let result: DocumentsResult[] = this.allDocumentsStmt.all(this.version);
		if (result === undefined) {
			return [];
		}
		return result.map((item) => { return { id: item.documentId, uri: item.uri } });
	}

	private getBlob(documentId: Id): DocumentBlob {
		let result = this.blobs.get(documentId);
		if (result === undefined) {
			const blobResult: BlobResult = this.findBlobStmt.get(documentId);
			result = JSON.parse(blobResult.content) as DocumentBlob;
			this.blobs.set(documentId, result);
		}
		return result;
	}

	protected findFile(uri: string): Id | undefined {
		let result: DocumentResult = this.findDocumentStmt.get({ version: this.version, uri: uri });
		return result !== undefined ? result.documentId : undefined;
	}

	protected fileContent(documentId: Id): string {
		const blob = this.getBlob(documentId);
		return Buffer.from(blob.contents).toString('base64');
	}

	public foldingRanges(uri: string): lsp.FoldingRange[] | undefined {
		return undefined;
	}

	public documentSymbols(uri: string): lsp.DocumentSymbol[] | undefined {
		return undefined;
	}

	public hover(uri: string, position: lsp.Position): lsp.Hover | undefined {
		const documentId = this.findFile(this.toDatabase(uri));
		if (documentId === undefined) {
			return undefined;
		}

		const range = this.findRangeFromPosition(documentId, position);
		if (range === undefined) {
			return undefined;
		}
		const blob = this.getBlob(documentId);
		if (blob.hovers === undefined) {
			return undefined;
		}
		let current: RangeData | ResultSetData | undefined = range;
		while (current !== undefined) {
			if (current.hoverResult !== undefined) {
				return blob.hovers[current.hoverResult];
			}
			current = current.next !== undefined
				? (blob.resultSets !== undefined ? blob.resultSets[current.next] : undefined)
				: undefined;
		}
		return undefined;
	}

	public declarations(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		return undefined;
	}

	public definitions(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		return undefined;
	}

	public references(uri: string, position: lsp.Position, context: lsp.ReferenceContext): lsp.Location[] | undefined {
		return undefined;
	}

	private resolveReferenceResult(locations: lsp.Location[], referenceResult: ReferenceResult, context: lsp.ReferenceContext, dedup: Set<Id>): void {
	}

	private findRangeFromPosition(documentId: Id, position: lsp.Position): RangeData | undefined {
		const blob = this.getBlob(documentId);

		let candidate: RangeData | undefined;
		for (let key of Object.keys(blob.ranges)) {
			let range = blob.ranges[key];
			if (BlobStore.containsPosition(range, position)) {
				if (!candidate) {
					candidate = range;
				} else {
					if (BlobStore.containsRange(candidate, range)) {
						candidate = range;
					}
				}
			}

		}
		return candidate;
	}

	private static containsPosition(range: lsp.Range, position: lsp.Position): boolean {
		if (position.line < range.start.line || position.line > range.end.line) {
			return false;
		}
		if (position.line === range.start.line && position.character < range.start.character) {
			return false;
		}
		if (position.line === range.end.line && position.character > range.end.character) {
			return false;
		}
		return true;
	}

	/**
	 * Test if `otherRange` is in `range`. If the ranges are equal, will return true.
	 */
	public static containsRange(range: lsp.Range, otherRange: lsp.Range): boolean {
		if (otherRange.start.line < range.start.line || otherRange.end.line < range.start.line) {
			return false;
		}
		if (otherRange.start.line > range.end.line || otherRange.end.line > range.end.line) {
			return false;
		}
		if (otherRange.start.line === range.start.line && otherRange.start.character < range.start.character) {
			return false;
		}
		if (otherRange.end.line === range.end.line && otherRange.end.character > range.end.character) {
			return false;
		}
		return true;
	}
}