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
	documentHash: string;
	uri: string;
}

interface BlobResult {
	content: Buffer;
}

interface DocumentResult {
	id: Id;
	documentHash: string;
}

interface DefsResult {
	uri: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

interface DeclsResult {
	uri: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

interface RefsResult {
	uri: string;
	kind: number;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

export class BlobStore extends Database {

	private db!: Sqlite.Database;

	private allDocumentsStmt!: Sqlite.Statement;
	private findDocumentStmt!: Sqlite.Statement;
	private findBlobStmt!: Sqlite.Statement;
	private findDeclsStmt!: Sqlite.Statement;
	private findDefsStmt!: Sqlite.Statement;
	private findRefsStmt!: Sqlite.Statement;
	private findHoverStmt!: Sqlite.Statement;

	private version!: string;
	private workspaceRoot!: URI;
	private blobs: Map<Id, DocumentBlob>;

	public constructor() {
		super();
		this.version;
		this.blobs = new Map();
	}

	public load(file: string, transformerFactory: (workspaceRoot: string) => UriTransformer): Promise<void> {
		this.db = new Sqlite(file, { readonly: true });
		this.readMetaData();
		/* eslint-disable indent */
		this.allDocumentsStmt = this.db.prepare([
			'Select d.documentHash, d.uri From documents d',
				'Inner Join versions v On v.hash = d.documentHash',
				'Where v.version = ?'
		].join(' '));
		this.findDocumentStmt = this.db.prepare([
			'Select d.documentHash From documents d',
				'Inner Join versions v On v.hash = d.documentHash',
				'Where v.version = $version and d.uri = $uri'
		].join(' '));
		this.findBlobStmt = this.db.prepare('Select content From blobs Where hash = ?');
		this.findDeclsStmt = this.db.prepare([
			'Select doc.uri, d.startLine, d.startCharacter, d.endLine, d.endCharacter From decls d',
				'Inner Join versions v On d.documentHash = v.hash',
				'Inner Join documents doc On d.documentHash = doc.documentHash',
				'Where v.version = $version and d.scheme = $scheme and d.identifier = $identifier'
		].join(' '));
		this.findDefsStmt = this.db.prepare([
			'Select doc.uri, d.startLine, d.startCharacter, d.endLine, d.endCharacter From defs d',
				'Inner Join versions v On d.documentHash = v.hash',
				'Inner Join documents doc On d.documentHash = doc.documentHash',
				'Where v.version = $version and d.scheme = $scheme and d.identifier = $identifier'
		].join(' '));
		this.findRefsStmt = this.db.prepare([
			'Select doc.uri, r.kind, r.startLine, r.startCharacter, r.endLine, r.endCharacter From refs r',
				'Inner Join versions v On r.documentHash = v.hash',
				'Inner Join documents doc On r.documentHash = doc.documentHash',
				'Where v.version = $version and r.scheme = $scheme and r.identifier = $identifier'
		].join(' '));
		this.findHoverStmt = this.db.prepare([
			'Select b.content From blobs b',
				'Inner Join versions v On b.hash = v.hash',
				'Inner Join hovers h On h.hoverHash = b.hash',
				'Where v.version = $version and h.scheme = $scheme and h.identifier = $identifier'

		].join(' '));
		/* eslint-enable indent */
		this.version = (this.db.prepare('Select * from versionTags Order by dateTime desc').get() as any).tag;
		if (typeof this.version !== 'string') {
			throw new Error('Version tag must be a string');
		}
		this.initialize(transformerFactory);
		return Promise.resolve();
	}

	private readMetaData(): void {
		let result: MetaDataResult[] = this.db.prepare('Select * from meta').all() as MetaDataResult[];
		if (result === undefined || result.length !== 1) {
			throw new Error('Failed to read meta data record.');
		}
		let metaData: MetaData = JSON.parse(result[0].value);
	}

	public getWorkspaceRoot(): URI {
		return this.workspaceRoot;
	}

	public close(): void {
		this.db.close();
	}

	protected getDocumentInfos(): DocumentInfo[] {
		let result: DocumentsResult[] = this.allDocumentsStmt.all(this.version) as DocumentsResult[];
		if (result === undefined) {
			return [];
		}
		return result.map((item) => { return { id: item.documentHash, uri: item.uri, hash: item.documentHash }; });
	}

	private getBlob(documentId: Id): DocumentBlob {
		let result = this.blobs.get(documentId);
		if (result === undefined) {
			const blobResult: BlobResult = this.findBlobStmt.get(documentId) as BlobResult;
			result = JSON.parse(blobResult.content.toString('utf8')) as DocumentBlob;
			this.blobs.set(documentId, result);
		}
		return result;
	}

	protected findFile(uri: string): { id: Id, hash: string | undefined }| undefined {
		let result: DocumentResult = this.findDocumentStmt.get({ version: this.version, uri: uri }) as DocumentResult;
		return result !== undefined ? { id: result.id, hash: result.documentHash} : undefined;
	}

	protected fileContent(info: { id: Id; hash: string | undefined }): string {
		const blob = this.getBlob(info.id);
		return Buffer.from(blob.contents).toString('base64');
	}

	public foldingRanges(uri: string): lsp.FoldingRange[] | undefined {
		return undefined;
	}

	public documentSymbols(uri: string): lsp.DocumentSymbol[] | undefined {
		return undefined;
	}

	public hover(uri: string, position: lsp.Position): lsp.Hover | undefined {
		const { range, blob } = this.findRangeFromPosition(this.toDatabase(uri), position);
		if (range === undefined || blob === undefined || blob.hovers === undefined) {
			return undefined;
		}
		let result = this.findResult(blob.resultSets, blob.hovers, range, 'hoverResult');
		if (result !== undefined) {
			return result;
		}
		const moniker = this.findMoniker(blob.resultSets, blob.monikers, range);
		if (moniker === undefined) {
			return undefined;
		}
		const qResult: BlobResult = this.findHoverStmt.get({ version: this.version, scheme: moniker.scheme, identifier: moniker.identifier }) as BlobResult;
		if (qResult === undefined) {
			return undefined;
		}
		result = JSON.parse(qResult.content.toString()) as lsp.Hover;
		if (result.range === undefined) {
			result.range = lsp.Range.create(range.start.line, range.start.character, range.end.line, range.end.character);
		}
		return result;
	}

	public declarations(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		const { range, blob } = this.findRangeFromPosition(this.toDatabase(uri), position);
		if (range === undefined || blob === undefined || blob.declarationResults === undefined) {
			return undefined;
		}
		let resultData = this.findResult(blob.resultSets, blob.declarationResults, range, 'declarationResult');
		if (resultData === undefined) {
			const moniker = this.findMoniker(blob.resultSets, blob.monikers, range);
			if (moniker === undefined) {
				return undefined;
			}
			return this.findDeclarationsInDB(moniker);
		} else {
			return BlobStore.asLocations(blob.ranges, uri, resultData.values);
		}
	}

	private findDeclarationsInDB(moniker: MonikerData): lsp.Location[] | undefined {
		let qResult: DeclsResult[] = this.findDeclsStmt.all({ version: this.version, scheme: moniker.scheme, identifier: moniker.identifier }) as DeclsResult[];
		if (qResult === undefined || qResult.length === 0) {
			return undefined;
		}
		return qResult.map((item) => {
			return lsp.Location.create(this.fromDatabase(item.uri), lsp.Range.create(item.startLine, item.startCharacter, item.endLine, item.endCharacter));
		});
	}

	public definitions(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		const { range, blob } = this.findRangeFromPosition(this.toDatabase(uri), position);
		if (range === undefined || blob === undefined || blob.definitionResults === undefined) {
			return undefined;
		}
		let resultData = this.findResult(blob.resultSets, blob.definitionResults, range, 'definitionResult');
		if (resultData === undefined) {
			const moniker = this.findMoniker(blob.resultSets, blob.monikers, range);
			if (moniker === undefined) {
				return undefined;
			}
			return this.findDefinitionsInDB(moniker);
		} else {
			return BlobStore.asLocations(blob.ranges, uri, resultData.values);
		}
	}

	private findDefinitionsInDB(moniker: MonikerData): lsp.Location[] | undefined {
		let qResult: DefsResult[] = this.findDefsStmt.all({ version: this.version, scheme: moniker.scheme, identifier: moniker.identifier }) as DefsResult[];
		if (qResult === undefined || qResult.length === 0) {
			return undefined;
		}
		return qResult.map((item) => {
			return lsp.Location.create(this.fromDatabase(item.uri), lsp.Range.create(item.startLine, item.startCharacter, item.endLine, item.endCharacter));
		});
	}

	public references(uri: string, position: lsp.Position, context: lsp.ReferenceContext): lsp.Location[] | undefined {
		const { range, blob } = this.findRangeFromPosition(this.toDatabase(uri), position);
		if (range === undefined || blob === undefined || blob.referenceResults === undefined) {
			return undefined;
		}
		let resultData = this.findResult(blob.resultSets, blob.referenceResults, range, 'referenceResult');
		if (resultData === undefined) {
			const moniker = this.findMoniker(blob.resultSets, blob.monikers, range);
			if (moniker === undefined) {
				return undefined;
			}
			return this.findReferencesInDB(moniker, context);
		} else {
			let result: lsp.Location[] = [];
			if (context.includeDeclaration && resultData.declarations !== undefined) {
				result.push(...BlobStore.asLocations(blob.ranges, uri, resultData.declarations));
			}
			if (context.includeDeclaration && resultData.definitions !== undefined) {
				result.push(...BlobStore.asLocations(blob.ranges, uri, resultData.definitions));
			}
			if (resultData.references !== undefined) {
				result.push(...BlobStore.asLocations(blob.ranges, uri, resultData.references));
			}
			return result;
		}
	}

	private findReferencesInDB(moniker: MonikerData, context: lsp.ReferenceContext): lsp.Location[] | undefined {
		let qResult: RefsResult[] = this.findRefsStmt.all({ version: this.version, scheme: moniker.scheme, identifier: moniker.identifier }) as RefsResult[];
		if (qResult === undefined || qResult.length === 0) {
			return undefined;
		}
		let result: lsp.Location[] = [];
		for (let item of qResult) {
			if (context.includeDeclaration || item.kind === 2) {
				result.push(lsp.Location.create(this.fromDatabase(item.uri), lsp.Range.create(item.startLine, item.startCharacter, item.endLine, item.endCharacter)));
			}
		}
		return result;
	}

	private findResult<T>(resultSets: LiteralMap<ResultSetData> | undefined, map: LiteralMap<T>, data: RangeData | ResultSetData, property: keyof (RangeData | ResultSetData)): T | undefined {
		let current: RangeData | ResultSetData | undefined = data;
		while (current !== undefined) {
			let value = current[property];
			if (value !== undefined) {
				return map[value];
			}
			current = current.next !== undefined
				? (resultSets !== undefined ? resultSets[current.next] : undefined)
				: undefined;
		}
		return undefined;
	}

	private findMoniker(resultSets: LiteralMap<ResultSetData> | undefined, monikers: LiteralMap<MonikerData> | undefined, data: RangeData | ResultSetData): MonikerData | undefined {
		if (monikers === undefined) {
			return undefined;
		}
		let current: RangeData | ResultSetData | undefined = data;
		let result: Id | undefined;
		while (current !== undefined) {
			if (current.moniker !== undefined) {
				result = current.moniker;
			}
			current = current.next !== undefined
				? (resultSets !== undefined ? resultSets[current.next] : undefined)
				: undefined;
		}
		return result !== undefined ? monikers[result] : undefined;
	}

	private findRangeFromPosition(uri: string, position: lsp.Position): { range: RangeData | undefined, blob: DocumentBlob | undefined } {
		const documentId = this.findFile(uri);
		if (documentId === undefined) {
			return { range: undefined, blob: undefined };
		}
 		const blob = this.getBlob(documentId.id);
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
		return { range: candidate, blob};
	}

	private static asLocations(ranges: LiteralMap<RangeData>, uri: string, ids: Id[]): lsp.Location[] {
		return ids.map(id => {
			let range = ranges[id];
			return lsp.Location.create(uri, lsp.Range.create(range.start.line, range.start.character, range.end.line, range.end.character));
		});
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