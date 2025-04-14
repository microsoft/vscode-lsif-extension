/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as Sqlite from 'better-sqlite3';

import * as lsp from 'vscode-languageserver';

import { Database, UriTransformer } from './database';
import {
	Id, EdgeLabels, DefinitionResult, FoldingRangeResult, DocumentSymbolResult, RangeBasedDocumentSymbol, Range, HoverResult,
	ReferenceResult, ItemEdgeProperties, DeclarationResult, Moniker, MonikerKind, VertexLabels, Vertex, Source
} from 'lsif-protocol';
import { MetaData, CompressorDescription, CompressionKind } from './protocol.compress';
import { DocumentInfo } from './files';
import { URI } from 'vscode-uri';

interface DecompressorPropertyDescription {
	name: string;
	index: number;
	compressionKind: CompressionKind
	longForm?: Map<string | number, string>;
}

class Decompressor {

	public static all: Map<number, Decompressor> = new Map();

	public static get(id: number): Decompressor | undefined {
		return this.all.get(id);
	}

	private id: number;
	private parentId: number | undefined;
	private parent: Decompressor | undefined;
	private properties: DecompressorPropertyDescription[];

	constructor(description: CompressorDescription) {
		this.id = description.id;
		this.parentId = description.parent;
		this.properties = [];
		for (let item of description.properties) {
			let propertyDescription: DecompressorPropertyDescription = {
				name: item.name,
				index: item.index,
				compressionKind: item.compressionKind,
				longForm: undefined
			};
			if (item.shortForm !== undefined) {
				propertyDescription.longForm = new Map();
				for (let element of item.shortForm) {
					propertyDescription.longForm.set(element[1], element[0]);
				}
			}
			this.properties.push(propertyDescription);
		}
		Decompressor.all.set(this.id, this);
	}

	public link(): void {
		if (this.parentId !== undefined) {
			this.parent = Decompressor.get(this.parentId);
		}
	}

	public getPropertyDescription(name: string): DecompressorPropertyDescription | undefined {
		for (let item of this.properties) {
			if (item.name === name) {
				return item;
			}
		}
		return undefined;
	}

	public decompress<T = object>(compressed: any[]): T {
		let result = this.parent !== undefined ? this.parent.decompress(compressed) : Object.create(null);
		for (let property of this.properties) {
			let index = property.index;
			let value = compressed[index];
			if (value === null || value === undefined) {
				continue;
			}
			let decompressor: Decompressor | undefined;
			switch (property.compressionKind) {
				case CompressionKind.id:
					result[property.name] = value;
					break;
				case CompressionKind.ids:
					result[property.name] = value;
					break;
				case CompressionKind.raw:
					result[property.name] = value;
					break;
				case CompressionKind.scalar:
					let convertedScalar = value;
					if (property.longForm !== undefined) {
						let long = property.longForm.get(value);
						if (long !== undefined) {
							convertedScalar = long;
						}
					}
					let dotIndex = property.name.indexOf('.');
					if (dotIndex !== -1) {
						let container = property.name.substr(0, dotIndex);
						let name = property.name.substring(dotIndex + 1);
						if (result[container] === undefined) {
							result[container] = Object.create(null);
						}
						result[container][name] = convertedScalar;
					} else {
						result[property.name] = convertedScalar;
					}
					break;
				case CompressionKind.literal:
					if (!Array.isArray(value) || typeof value[0] !== 'number') {
						throw new Error(`Compression kind literal detected on non array value. The property is ${property.name}`);
					}
					let convertedLiteral: any;
					decompressor = Decompressor.get(value[0]);
					if (decompressor === undefined) {
						throw new Error(`No decompression found for property ${property.name} and id ${value[0]}`);
					}
					convertedLiteral = decompressor.decompress(value);
					result[property.name] = convertedLiteral;
					break;
				case CompressionKind.array:
					if (!Array.isArray(value)) {
						throw new Error(`Compression kind array detected on non array value. The property is ${property.name}`);
					}
					let convertedArray: any[] = [];
					for (let element of value) {
						let type = typeof element;
						if (type === 'string' || type === 'number' || type === 'boolean') {
							convertedArray.push(element);
						} else if (Array.isArray(element) && element.length > 0 && typeof element[0] === 'number') {
							decompressor = Decompressor.get(element[0]);
							if (decompressor === undefined) {
								throw new Error(`No decompression found for property ${property.name} and id ${element[0]}`);
							}
							convertedArray.push(decompressor.decompress(element));
						} else {
							throw new Error(`The array element is neither a scalar nor an array.`);
						}
					}
					result[property.name] = convertedArray;
					break;
				case CompressionKind.any:
					let convertedAny: any;
					let type = typeof value;
					if (type === 'string' || type === 'number' || type === 'boolean') {
						convertedAny = value;
					} else if (Array.isArray(value)) {
						convertedAny = [];
						for (let element of value) {
							let type = typeof element;
							if (type === 'string' || type === 'number' || type === 'boolean') {
								(convertedAny as any[]).push(element);
							} else if (Array.isArray(element) && element.length > 0 && typeof element[0] === 'number') {
								decompressor = Decompressor.get(element[0]);
								if (decompressor === undefined) {
									throw new Error(`No decompression found for property ${property.name} and id ${element[0]}`);
								}
								(convertedAny as any[]).push(decompressor.decompress(element));
							} else {
								throw new Error(`The array element is neither a scalar nor an array.`);
							}
						}
					}
					if (convertedAny === undefined) {
						throw new Error(`Comression kind any can't be handled for property ${property.name}. Value is ${JSON.stringify(value)}`);
					}
					result[property.name] = convertedAny;
					break;
				default:
					throw new Error(`Compression kind ${property.compressionKind} unknown.`);
			}
		}
		return result;
	}
}

interface RangeResult {
	id: number;
	belongsTo: number;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

interface MetaDataResult {
	id: number;
	value: string;
}

interface IdResult {
	id: Id;
}

interface LocationResult extends IdResult {
	uri: string;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
}

interface LocationResultWithProperty extends LocationResult {
	property: number;
}

interface DocumentResult extends IdResult {
	label: number;
	value: string;
}

interface VertexResult extends IdResult {
	label: number;
	value: string;
}

interface ContentResult extends IdResult {
	content: string;
}

interface NextResult {
	inV: number;
}

interface PreviousResult {
	outV: number;
}

interface DocumentInfoResult extends IdResult {
	projectId: Id;
	uri: string;
	documentHash: string;
}

abstract class Retriever<T extends IdResult> {

	private values: Id[];

	public constructor(private name: string, private db: Sqlite.Database, private batchSize: number) {
		this.values= [];
	}

	public clear(): void {
		this.values = [];
	}

	public get isEmpty(): boolean {
		return this.values.length === 0;
	}

	public add(id: Id): void {
		this.values.push(id);
	}

	public addMany(ids: Id[]): void {
		this.values.push(...ids);
	}

	public run(): T[] {
		let result: T[] = new Array(this.values.length);
		let batch: Id[] = [];
		let mapping: Map<Id, number> = new Map();
		for (let i = 0; i < this.values.length; i++) {
			let value = this.values[i];
			batch.push(value);
			mapping.set(value, i);
			if (batch.length === this.batchSize) {
				this.retrieveBatch(result, batch, mapping);
				batch = [];
				mapping.clear();
			}
		}
		if (batch.length > 0) {
			this.retrieveBatch(result, batch, mapping);
		}
		this.values = [];
		return result;
	}

	private retrieveBatch(result: T[], batch: Id[], mapping: Map<Id, number>): void {
		let stmt = batch.length === this.batchSize
			? this.getFullStatement(this.batchSize)
			: this.getRestStatement(batch.length);

		let data: T[] = stmt.all(batch) as T[];
		if (batch.length !== data.length) {
			throw new Error(`Couldn't retrieve all data for retriever ${this.name}`);
		}
		for (let element of data) {
			result[mapping.get(element.id)!] = element;
		}
	}

	protected prepare(stmt: string, size: number): Sqlite.Statement {
		return this.db.prepare(`${stmt} (${new Array(size).fill('?').join(',')})`);
	}

	protected abstract getFullStatement(size: number): Sqlite.Statement;

	protected abstract getRestStatement(size: number): Sqlite.Statement;
}

class VertexRetriever extends Retriever<VertexResult> {

	private static statement: string = [
		'Select v.id, v.label, v.value from vertices v',
		'Where v.id in'
	].join(' ');

	private static preparedStatements: Map<number, Sqlite.Statement> = new Map();

	public constructor(db: Sqlite.Database, batchSize: number = 16) {
		super('VertexRetriever', db, batchSize);
	}

	protected getFullStatement(size: number): Sqlite.Statement {
		let result = VertexRetriever.preparedStatements.get(size);
		if (!result) {
			result = this.prepare(VertexRetriever.statement, size);
			VertexRetriever.preparedStatements.set(size, result);
		}
		return result;
	}

	protected getRestStatement(size: number): Sqlite.Statement {
		return this.prepare(VertexRetriever.statement, size);
	}
}

class LocationRetriever extends Retriever<LocationResult> {

	private static statement: string = [
		'Select r.id, r.startLine, r.startCharacter, r.endLine, r.endCharacter, d.uri from ranges r',
		'Inner Join documents d On r.belongsTo = d.id',
		'Where r.id in'
	].join(' ');

	private static preparedStatements: Map<number, Sqlite.Statement> = new Map();

	public constructor(db: Sqlite.Database, batchSize: number = 16) {
		super('LocationRetriever', db, batchSize);
	}

	protected getFullStatement(size: number): Sqlite.Statement {
		let result = LocationRetriever.preparedStatements.get(size);
		if (!result) {
			result = this.prepare(LocationRetriever.statement, size);
			LocationRetriever.preparedStatements.set(size, result);
		}
		return result;
	}

	protected getRestStatement(size: number): Sqlite.Statement {
		return this.prepare(LocationRetriever.statement, size);
	}
}

export class GraphStore extends Database {

	private db!: Sqlite.Database;

	private allDocumentsStmt!: Sqlite.Statement;
	private getDocumentContentStmt!: Sqlite.Statement;
	private findRangeStmt!: Sqlite.Statement;
	private findDocumentStmt!: Sqlite.Statement;
	private findResultStmt!: Sqlite.Statement;
	private findMonikerStmt!: Sqlite.Statement;
	private findMatchingMonikersStmt!: Sqlite.Statement;
	private findAttachedMonikersStmt!: Sqlite.Statement;
	private findNextMonikerStmt!: Sqlite.Statement;
	private findVertexIdForMonikerStmt!: Sqlite.Statement;
	private findNextVertexStmt!: Sqlite.Statement;
	private findPreviousVertexStmt!: Sqlite.Statement;
	private findResultForDocumentStmt!: Sqlite.Statement;
	private findRangeFromReferenceResult!: Sqlite.Statement;
	private findResultFromReferenceResult!: Sqlite.Statement;
	private findCascadesFromReferenceResult!: Sqlite.Statement;
	private findRangeFromResult!: Sqlite.Statement;

	private workspaceRoot!: URI;
	private vertexLabels: Map<string, number> | undefined;
	private edgeLabels: Map<string, number> | undefined;
	private itemEdgeProperties: Map<string, number> | undefined;

	public constructor() {
		super();
	}

	public load(file: string, transformerFactory: (workspaceRoot: string) => UriTransformer): Promise<void> {
		this.db = new Sqlite(file, { readonly: true });
		this.readMetaData();
		this.readSource();
		this.allDocumentsStmt = this.db.prepare('Select id, uri, documentHash From documents');
		this.getDocumentContentStmt = this.db.prepare('Select content From contents Where documentHash = ?');
		this.findDocumentStmt = this.db.prepare('Select id From documents Where uri = ?');
		/* eslint-disable indent */
		this.findRangeStmt = this.db.prepare([
			'Select r.id, r.belongsTo, r.startLine, r.startCharacter, r.endline, r.endCharacter From ranges r',
			'Inner Join documents d On r.belongsTo = d.id',
			'where',
				'd.uri = $uri and (',
					'(r.startLine < $line and $line < r.endline) or',
					'(r.startLine = $line and r.startCharacter <= $character and $line < r.endline) or',
					'(r.startLine < $line and r.endLine = $line and $character <= r.endCharacter) or',
					'(r.startLine = $line and r.endLine = $line and r.startCharacter <= $character and $character <= r.endCharacter)',
			  	')'
		].join(' '));
		/* eslint-enable indent */
		const nextLabel = this.edgeLabels !== undefined ? this.edgeLabels.get(EdgeLabels.next)! : EdgeLabels.next;
		const monikerEdgeLabel = this.edgeLabels !== undefined ? this.edgeLabels.get(EdgeLabels.moniker)! : EdgeLabels.moniker;
		const monikerAttachLabel = this.edgeLabels !== undefined ? this.edgeLabels.get(EdgeLabels.attach)! : EdgeLabels.attach;

		this.findResultStmt = this.db.prepare([
			'Select v.id, v.label, v.value From vertices v',
			'Inner Join edges e On e.inV = v.id',
			'Where e.outV = $source and e.label = $label'
		].join(' '));

		this.findMonikerStmt = this.db.prepare([
			'Select v.id, v.label, v.value From vertices v',
			'Inner Join edges e On e.inV = v.id',
			`Where e.outV = $source and e.label = ${monikerEdgeLabel}`
		].join(' '));
		this.findMatchingMonikersStmt = this.db.prepare([
			'Select v.id, v.label, v.value From vertices v',
			'Inner Join monikers m on v.id = m.id',
			'Where m.identifier = $identifier and m.scheme = $scheme and m.id != $exclude'
		].join(' '));
		this.findAttachedMonikersStmt = this.db.prepare([
			'Select v.id, v.label, v.value from vertices v',
			'Inner Join edges e On e.outV = v.id',
			`Where e.inV = $source and e.label = ${monikerAttachLabel}`
		].join(' '));
		this.findNextMonikerStmt = this.db.prepare([
			'Select e.inV From edges e',
			`Where e.outV = $source and e.label = ${monikerAttachLabel}`
		].join(' '));
		this.findVertexIdForMonikerStmt = this.db.prepare([
			'Select v.id from vertices v',
			'INNER Join edges e On v.id = e.outV',
			`Where e.label = ${monikerEdgeLabel} and e.inV = $id`
		].join(' '));

		this.findNextVertexStmt = this.db.prepare([
			'Select e.inV From edges e',
			`Where e.outV = $source and e.label = ${nextLabel}`
		].join(' '));
		this.findPreviousVertexStmt = this.db.prepare([
			'Select e.outV From edges e',
			`Where e.inV = $source and e.label = ${nextLabel}`
		].join(' '));

		this.findResultForDocumentStmt = this.db.prepare([
			'Select v.id, v.label, v.value from vertices v',
			'Inner Join edges e On e.inV = v.id',
			'Inner Join documents d On d.id = e.outV',
			'Where d.uri = $uri and e.label = $label'
		].join(' '));

		this.findRangeFromResult = this.db.prepare([
			'Select r.id, r.startLine, r.startCharacter, r.endLine, r.endCharacter, d.uri from ranges r',
			'Inner Join items i On i.inV = r.id',
			'Inner Join documents d On r.belongsTo = d.id',
			'Where i.outV = $id'
		].join(' '));
		this.findRangeFromReferenceResult = this.db.prepare([
			'Select r.id, r.startLine, r.startCharacter, r.endLine, r.endCharacter, i.property, d.uri from ranges r',
			'Inner Join items i On i.inV = r.id',
			'Inner Join documents d On r.belongsTo = d.id',
			'Where i.outV = $id and (i.property in (1, 2, 3))'
		].join(' '));
		this.findResultFromReferenceResult = this.db.prepare([
			'Select v.id, v.label, v.value from vertices v',
			'Inner Join items i On i.inV = v.id',
			'Where i.outV = $id and i.property = 4'
		].join(' '));
		this.findCascadesFromReferenceResult = this.db.prepare([
			'Select v.id, v.label, v.value from vertices v',
			'Inner Join items i On i.inV = v.id',
			'Where i.outV = $id and i.property = 5'
		].join(' '));
		this.initialize(transformerFactory);
		return Promise.resolve();
	}

	private readMetaData(): void {
		let result: MetaDataResult[] = this.db.prepare('Select * from meta').all() as MetaDataResult[];
		if (result === undefined || result.length !== 1) {
			throw new Error('Failed to read meta data record.');
		}
		let metaData: MetaData = JSON.parse(result[0].value);
		if (metaData.compressors !== undefined) {
			this.vertexLabels = new Map();
			this.edgeLabels = new Map();
			this.itemEdgeProperties = new Map();
			for (let decription of metaData.compressors.all) {
				new Decompressor(decription);
			}
			for (let element of Decompressor.all.values()) {
				element.link();
			}
			// Vertex Compressor
			let decompressor = Decompressor.get(metaData.compressors.vertexCompressor);
			if (decompressor === undefined) {
				throw new Error('No vertex decompressor found.');
			}
			let description = decompressor.getPropertyDescription('label');
			if (description === undefined || description.longForm === undefined) {
				throw new Error('No vertex label property description found.');
			}
			for (let item of description.longForm) {
				this.vertexLabels.set(item[1], item[0] as number);
			}
			// Edge Compressor
			decompressor = Decompressor.get(metaData.compressors.edgeCompressor);
			if (decompressor === undefined) {
				throw new Error('No edge decompressor found.');
			}
			description = decompressor.getPropertyDescription('label');
			if (description === undefined || description.longForm === undefined) {
				throw new Error('No edge label property description found.');
			}
			for (let item of description.longForm) {
				this.edgeLabels.set(item[1], item[0] as number);
			}
			// Item edge Compressor
			decompressor = Decompressor.get(metaData.compressors.itemEdgeCompressor);
			if (decompressor === undefined) {
				throw new Error('No item edge decompressor found.');
			}
			description = decompressor.getPropertyDescription('property');
			if (description === undefined || description.longForm === undefined) {
				throw new Error('No item property description found.');
			}
			for (let item of description.longForm) {
				this.itemEdgeProperties.set(item[1], item[0] as number);
			}
		}
	}

	private readSource(): void {
		const sourceLabel = this.vertexLabels !== undefined ? this.vertexLabels.get(VertexLabels.source): VertexLabels.source;
		const source: Source = this.decompress(JSON.parse((this.db.prepare(`Select v.value from vertices v where v.label = ${sourceLabel}`).get() as any).value));
		if (source !== undefined) {
			this.workspaceRoot = URI.parse(source.workspaceRoot);
		}
	}

	public getWorkspaceRoot(): URI {
		return this.workspaceRoot;
	}

	public close(): void {
		this.db.close();
	}

	protected getDocumentInfos(): DocumentInfo[] {
		let result: DocumentInfoResult[] = this.allDocumentsStmt.all() as DocumentInfoResult[];
		if (result === undefined) {
			return [];
		}
		return result.map((item) => { return { id: item.id, uri: item.uri, hash: item.documentHash }; });
	}

	protected findFile(uri: string): { id: Id, hash: string | undefined } | undefined {
		let result = this.findDocumentStmt.get(uri) as any;
		return result;
	}

	protected fileContent(info: { id: Id, hash: string | undefined }): string {
		let result: ContentResult = this.getDocumentContentStmt.get(info.hash) as ContentResult;
		if (!result || !result.content) {
			return '';
		}
		return Buffer.from(result.content).toString('base64');
	}

	public foldingRanges(uri: string): lsp.FoldingRange[] | undefined {
		let foldingResult = this.getResultForDocument(this.toDatabase(uri), EdgeLabels.textDocument_foldingRange);
		if (foldingResult === undefined) {
			return undefined;
		}
		return foldingResult.result;
	}

	public documentSymbols(uri: string): lsp.DocumentSymbol[] | undefined {
		let symbolResult = this.getResultForDocument(this.toDatabase(uri), EdgeLabels.textDocument_documentSymbol);
		if (symbolResult === undefined) {
			return undefined;
		}
		if (symbolResult.result.length === 0) {
			return [];
		}
		if (lsp.DocumentSymbol.is(symbolResult.result[0])) {
			return symbolResult.result as lsp.DocumentSymbol[];
		} else {
			const vertexRetriever = new VertexRetriever(this.db, 16);
			let collectRanges = (element: RangeBasedDocumentSymbol) => {
				vertexRetriever.add(element.id);
				if (element.children) {
					element.children.forEach(collectRanges);
				}
			};
			let convert = (result: lsp.DocumentSymbol[], elements: RangeBasedDocumentSymbol[], ranges: Map<Id, Range>) => {
				for (let element of elements) {
					let range = ranges.get(element.id);
					if (range !== undefined) {
						let symbol: lsp.DocumentSymbol | undefined = this.asDocumentSymbol(range);
						if (symbol) {
							result.push(symbol);
							if (element.children !== undefined && element.children.length > 0) {
								symbol.children = [];
								convert(symbol.children, element.children, ranges);
							}
						}
					}
				}
			};
			(symbolResult.result as RangeBasedDocumentSymbol[]).forEach(collectRanges);
			let data = vertexRetriever.run();
			let ranges: Map<Id, Range> = new Map();
			for (let element of data) {
				let range: Range = this.decompress(JSON.parse(element.value));
				if (range) {
					ranges.set(range.id, range);
				}
			}
			let result: lsp.DocumentSymbol[] = [];
			convert(result, symbolResult.result as RangeBasedDocumentSymbol[], ranges);
			return result;
		}
	}

	public hover(uri: string, position: lsp.Position): lsp.Hover | undefined {
		const ranges = this.findRange(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const findHover = (range: RangeResult): lsp.Hover | undefined =>  {
			const [hoverResult, anchorId] = this.getResultForId(range.id, EdgeLabels.textDocument_hover);
			if (hoverResult === undefined || hoverResult.result === undefined) {
				return undefined;
			}
			const result: lsp.Hover = Object.assign(Object.create(null), hoverResult.result);
			if (result.range === undefined) {
				result.range = {
					start: {
						line: range.startLine,
						character: range.startCharacter
					},
					end: {
						line: range.endLine,
						character: range.endCharacter
					}
				};
			}
			return result;
		};

		let result: lsp.Hover | undefined;
		for (const range of ranges) {
			result = findHover(range);
			if (result !== undefined) {
				break;
			}
		}
		if (result === undefined) {
			return undefined;
		}

		// Workaround to remove empty object. Need to find out why they are in the dump
		// in the first place.
		if (Array.isArray(result.contents)) {
			for (let i = 0; i < result.contents.length;) {
				const elem = result.contents[i];
				if (typeof elem !== 'string' && elem.language === undefined && elem.value === undefined) {
					result.contents.splice(i, 1);
				} else {
					i++;
				}
			}
		}
		return result;
	}

	public declarations(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		const ranges = this.findRange(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const findDeclaration = (range: RangeResult): lsp.Location | lsp.Location[] | undefined => {
			const [declarationResult] = this.getResultForId(range.id, EdgeLabels.textDocument_declaration);
			if (declarationResult === undefined) {
				return undefined;
			}

			const result: lsp.Location[] = [];
			const queryResult: LocationResult[] = this.findRangeFromResult.all({ id: declarationResult.id }) as LocationResult[];
			if (queryResult && queryResult.length > 0) {
				for(let item of queryResult) {
					result.push(this.createLocation(item));
				}
			}
			return result;
		};

		for (const range of ranges) {
			const result = findDeclaration(range);
			if (result !== undefined) {
				return result;
			}
		}
		return undefined;
	}

	public definitions(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		const ranges = this.findRange(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const findDefinitions = (range: RangeResult): lsp.Location | lsp.Location[] | undefined => {
			const [definitionResult] = this.getResultForId(range.id, EdgeLabels.textDocument_definition);
			if (definitionResult === undefined) {
				return undefined;
			}

			const result: lsp.Location[] = [];
			const queryResult: LocationResult[] = this.findRangeFromResult.all({ id: definitionResult.id }) as  LocationResult[];
			if (queryResult && queryResult.length > 0) {
				for(let item of queryResult) {
					result.push(this.createLocation(item));
				}
			}
			return result;
		};

		for (const range of ranges) {
			const result = findDefinitions(range);
			if (result !== undefined) {
				return result;
			}
		}
		return undefined;
	}

	public references(uri: string, position: lsp.Position, context: lsp.ReferenceContext): lsp.Location[] | undefined {
		const ranges = this.findRange(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const result: lsp.Location[] = [];
		const monikers: Map<Id, Moniker> = new Map();
		const dedupRanges = new Set<Id>();

		const findReferences = (result: lsp.Location[], dedupRanges: Set<Id>, monikers: Map<Id, Moniker>, range: RangeResult): void => {
			const [referenceResult, anchorId] = this.getResultForId(range.id, EdgeLabels.textDocument_references);
			if (referenceResult === undefined) {
				return undefined;
			}

			this.resolveReferenceResult(result, dedupRanges, monikers, referenceResult, context);
			this.findMonikersForVertex(monikers, anchorId);
			for (const moniker of monikers.values()) {
				if (moniker.kind === MonikerKind.local) {
					continue;
				}
				const matchingMonikers = this.findMatchingMonikers(moniker);
				for (const matchingMoniker of matchingMonikers) {
					const vertexId = this.findVertexIdForMoniker(matchingMoniker);
					if (vertexId === undefined) {
						continue;
					}
					const [referenceResult] = this.getResultForId(vertexId, EdgeLabels.textDocument_references);
					if (referenceResult === undefined) {
						continue;
					}
					this.resolveReferenceResult(result, dedupRanges, monikers, referenceResult, context);
				}
			}
		};

		for (const range of ranges) {
			findReferences(result, dedupRanges, monikers, range);
		}

		return result;
	}

	private resolveReferenceResult(result: lsp.Location[], dedupRanges: Set<Id>, monikers: Map<Id, Moniker>, referenceResult: ReferenceResult, context: lsp.ReferenceContext): void {
		const qr: LocationResultWithProperty[] = this.findRangeFromReferenceResult.all({ id: referenceResult.id }) as LocationResultWithProperty[];
		if (qr && qr.length > 0) {
			const refLabel = this.getItemEdgeProperty(ItemEdgeProperties.references);
			for (const item of qr) {
				if (item.property === refLabel || context.includeDeclaration && !dedupRanges.has(item.id)) {
					dedupRanges.add(item.id);
					result.push(this.createLocation(item));
				}
			}
		}

		const mr: VertexResult[] = this.findCascadesFromReferenceResult.all({ id: referenceResult.id }) as VertexResult[];
		if (mr) {
			for (const moniker of mr) {
				if (!monikers.has(moniker.id)) {
					monikers.set(moniker.id, this.decompress(JSON.parse(moniker.value)));
				}
			}
		}

		const rqr: VertexResult[] = this.findResultFromReferenceResult.all({ id: referenceResult.id }) as VertexResult[];
		if (rqr && rqr.length > 0) {
			for (const item of rqr) {
				this.resolveReferenceResult(result, dedupRanges, monikers, this.decompress(JSON.parse(item.value)), context);
			}
		}
	}

	private findMonikersForVertex(monikers: Map<Id, Moniker>, id: Id): void {
		let currentId: Id = id;
		let moniker: VertexResult | undefined;
		do {
			moniker = this.findMonikerStmt.get({ source: currentId }) as VertexResult | undefined;
			if (moniker !== undefined) {
				break;
			}
			const previous: PreviousResult = this.findPreviousVertexStmt.get({ source: currentId }) as PreviousResult;
			if (previous === undefined) {
				moniker = undefined;
				break;
			}
			currentId = previous.outV;
		} while (currentId !== undefined);
		if (moniker === undefined) {
			return;
		}
		const result: Moniker[] = [this.decompress(JSON.parse(moniker.value))];
		for (const moniker of result) {
			monikers.set(moniker.id, moniker);
			const attachedMonikersResult: VertexResult[] = this.findAttachedMonikersStmt.all({ source: moniker.id }) as VertexResult[];
			for (const attachedMonikerResult of attachedMonikersResult) {
				const attachedMoniker: Moniker = this.decompress(JSON.parse(attachedMonikerResult.value));
				monikers.set(attachedMoniker.id, attachedMoniker);
			}
		}
	}

	private findMatchingMonikers(moniker: Moniker): Moniker[] {
		const results: VertexResult[] = this.findMatchingMonikersStmt.all({ identifier: moniker.identifier, scheme: moniker.scheme, exclude: moniker.id }) as  VertexResult[];
		return results.map(vertex => this.decompress(JSON.parse(vertex.value)));
	}

	private findVertexIdForMoniker(moniker: Moniker): Id | undefined {
		let currentId: Id = moniker.id;
		do {
			const next: NextResult = this.findNextMonikerStmt.get({ source: currentId }) as NextResult;
			if (next === undefined) {
				break;
			}
			currentId = next.inV;
		} while (currentId !== undefined);
		if (currentId === undefined) {
			return;
		}
		const result: IdResult = this.findVertexIdForMonikerStmt.get({ id: currentId }) as IdResult;
		return result !== undefined ? result.id : undefined;
	}

	private findRange(uri: string, position: lsp.Position): RangeResult[] | undefined {
		let dbResult: RangeResult[] = this.findRangeStmt.all({ uri: uri, line: position.line, character: position.character}) as RangeResult[];
		if (dbResult === undefined || dbResult.length === 0) {
			return undefined;
		}
		function sameRange(a: RangeResult, b: RangeResult): boolean {
			return a.startLine === b.startLine && a.startCharacter === b.startCharacter && a.endLine === b.endLine && a.endCharacter === b.endCharacter;
		}
		// Do to the indecies we use the items in the db result are sorted descending.
		const result: RangeResult[] = [];
		const last = dbResult[dbResult.length - 1];
		const belongsTo: Set<Id> = new Set();
		result.push(last);
		belongsTo.add(last.belongsTo);
		for (let i = result.length - 2; i >= 0; i--) {
			const candidate = dbResult[i];
			if (!belongsTo.has(candidate.belongsTo) && sameRange(last, candidate)) {
				result.push(candidate);
			} else {
				break;
			}
		}
		return result;
	}

	private getResultForId(id: Id, label: EdgeLabels.textDocument_hover): [HoverResult  | undefined, Id];
	private getResultForId(id: Id, label: EdgeLabels.textDocument_declaration): [DeclarationResult | undefined, Id];
	private getResultForId(id: Id, label: EdgeLabels.textDocument_definition): [DefinitionResult | undefined, Id];
	private getResultForId(id: Id, label: EdgeLabels.textDocument_references): [ReferenceResult | undefined, Id];
	private getResultForId(id: Id, label: EdgeLabels): [any | undefined, Id] {
		let currentId = id;
		let result: VertexResult | undefined;
		do {
			result = this.findResultStmt.get({ source: currentId, label: this.getEdgeLabel(label)}) as VertexResult | undefined;
			if (result !== undefined) {
				break;
			}
			const next: NextResult = this.findNextVertexStmt.get({ source: currentId }) as NextResult;
			if (next === undefined) {
				result = undefined;
				break;
			}
			currentId = next.inV;
		} while (currentId !== undefined);
		if (result === undefined) {
			return [undefined, currentId];
		}
		return [this.decompress(JSON.parse(result.value)), currentId];
	}

	private getEdgeLabel(label: EdgeLabels): EdgeLabels | number {
		if (this.edgeLabels === undefined) {
			return label;
		}
		let result = this.edgeLabels.get(label);
		return result !== undefined ? result : label;
	}

	private getItemEdgeProperty(prop: ItemEdgeProperties): ItemEdgeProperties | number {
		if (this.itemEdgeProperties === undefined) {
			return prop;
		}
		let result = this.itemEdgeProperties.get(prop);
		return result !== undefined ? result : prop;
	}

	private asLocations(values: (Id | lsp.Location)[]): lsp.Location[] {
		let mapping: Map<Id, number> = new Map();
		let ids: Id[] = [];
		let result: lsp.Location[] = new Array(values.length);
		for (let i = 0; i < values.length; i++) {
			let element = values[i];
			if (lsp.Location.is(element)) {
				result[i] = element;
			} else {
				mapping.set(element, i);
				ids.push(element);
			}
		}
		if (ids.length > 0) {
			const locationRetriever = new LocationRetriever(this.db);
			locationRetriever.addMany(ids);
			let data: LocationResult[] = locationRetriever.run();
			for (let element of data) {
				result[mapping.get(element.id)!] = this.createLocation(element);
			}
		}
		return result;
	}

	private asLocation(value: Id | lsp.Location): lsp.Location {
		if (lsp.Location.is(value)) {
			return { range: value.range, uri: this.fromDatabase(value.uri)};
		} else {
			const locationRetriever = new LocationRetriever(this.db, 1);
			locationRetriever.add(value);
			let data: LocationResult = locationRetriever.run()[0];
			return this.createLocation(data);
		}
	}

	private createLocation(data: LocationResult): lsp.Location {
		return lsp.Location.create(this.fromDatabase(data.uri), lsp.Range.create(data.startLine, data.startCharacter, data.endLine, data.endCharacter));
	}

	private getResultForDocument(uri: string, label: EdgeLabels.textDocument_documentSymbol): DocumentSymbolResult | undefined;
	private getResultForDocument(uri: string, label: EdgeLabels.textDocument_foldingRange): FoldingRangeResult | undefined;
	private getResultForDocument(uri: string, label: EdgeLabels): any | undefined {
		let data: DocumentResult = this.findResultForDocumentStmt.get({ uri, label: this.getEdgeLabel(label) }) as DocumentResult;
		if (data === undefined) {
			return undefined;
		}
		return this.decompress(JSON.parse(data.value));
	}

	private decompress(value: any): any {
		if (Array.isArray(value)) {
			let decompressor = Decompressor.get(value[0]);
			if (decompressor) {
				return decompressor.decompress(value);
			}
		}
		return value;
	}
}