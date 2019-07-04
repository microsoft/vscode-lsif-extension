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

export class BlobStore extends Database {

	private db!: Sqlite.Database;

	private allDocumentsStmt!: Sqlite.Statement;
	private findDocumentStmt!: Sqlite.Statement;
	private findBlobStmt!: Sqlite.Statement;

	private projectRoot!: URI;
	private blobs: Map<Id, DocumentBlob>;

	public constructor() {
		super();
		this.blobs = new Map();
	}

	public load(file: string, transformerFactory: (projectRoot: string) => UriTransformer): Promise<void> {
		this.db = new Sqlite(file, { readonly: true });
		this.readMetaData();
		this.allDocumentsStmt = this.db.prepare('Select d.documentId, d.uri From documents d Inner Join versions v On v.documentId = d.documentId Where v.versionId = ?');
		this.findDocumentStmt = this.db.prepare('Select documentId From documents Where uri = ?');
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
		let result: DocumentsResult[] = this.allDocumentsStmt.all('v1');
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
		let result = this.findDocumentStmt.get(uri);
		return result;
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
}