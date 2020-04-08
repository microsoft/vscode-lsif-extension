/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import * as crypto from 'crypto';

import * as Sqlite from 'better-sqlite3';
import * as lsp from 'vscode-languageserver';
import { URI } from 'vscode-uri';

import {
	Id, EdgeLabels, DefinitionResult, FoldingRangeResult, DocumentSymbolResult, RangeBasedDocumentSymbol, Range, HoverResult,
	ReferenceResult, ItemEdgeProperties, DeclarationResult, Moniker, Group, MonikerKind, Vertex, Edge, UniquenessLevel
} from 'lsif-protocol';
import { Database, UriTransformer } from './database';
import { MetaData, CompressorDescription, CompressionKind } from './protocol.compress';
import { DocumentInfo } from './files';
import { DedupeArray } from './dedupedArray';

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

interface AttachResult {
	inV: number;
}

interface DocumentInfoResult extends IdResult {
	groupId: Id;
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

		let data: T[] = stmt.all(batch);
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

interface ResultPath<T> {
	path: { vertex: Id, moniker: Moniker | undefined }[];
	result: { value: T, moniker: Moniker | undefined } | undefined;
}

namespace Locations {
	export function makeKey(location: lsp.Location): string {
		const range = location.range;
		return crypto.createHash('md5').update(JSON.stringify({ d: location.uri, sl: range.start.line, sc: range.start.character, el: range.end.line, ec: range.end.character }, undefined, 0)).digest('base64');
	}
}

namespace Monikers {
	export function makeKey(moniker: Moniker): string {
		return crypto.createHash('md5').update(JSON.stringify({ s: moniker.scheme, i: moniker.identifier }, undefined, 0)).digest('base64');
	}
}

export class GraphStore extends Database {

	private db!: Sqlite.Database;

	private allDocumentsStmt!: Sqlite.Statement;
	private getDocumentContentStmt!: Sqlite.Statement;
	private findRangesStmt!: Sqlite.Statement;
	private findDocumentStmt!: Sqlite.Statement;

	private retrieveResultStmt!: Sqlite.Statement;
	private retrieveNextVertexStmt!: Sqlite.Statement;

	private retrieveMonikerStmt!: Sqlite.Statement;
	private retrieveAttachMonikerStmt!: Sqlite.Statement;
	private findVerticesForMonikerStmt!: Sqlite.Statement;
	private findMatchingMonikersStmt!: Sqlite.Statement;
	private findAttachedMonikersStmt!: Sqlite.Statement;

	private retrieveResultForDocumentStmt!: Sqlite.Statement;
	private retrieveRangesFromResultStmt!: Sqlite.Statement;
	private findRangeFromReferenceResult!: Sqlite.Statement;
	private findResultFromReferenceResult!: Sqlite.Statement;
	private findLinksFromReferenceResult!: Sqlite.Statement;

	private projectRoot!: URI;
	private groupId!: Id;
	private vertexLabels: Map<string, number> | undefined;
	private edgeLabels: Map<string, number> | undefined;
	private itemEdgeProperties: Map<string, number> | undefined;

	public constructor() {
		super();
	}

	public load(file: string, transformerFactory: (projectRoot: string) => UriTransformer): Promise<void> {
		this.db = new Sqlite(file, { readonly: true });
		this.readMetaData();
		this.readGroup();

		const nextLabel = this.edgeLabels !== undefined ? this.edgeLabels.get(EdgeLabels.next)! : EdgeLabels.next;
		const monikerEdgeLabel = this.edgeLabels !== undefined ? this.edgeLabels.get(EdgeLabels.moniker)! : EdgeLabels.moniker;
		const attachEdgeLabel = this.edgeLabels !== undefined ? this.edgeLabels.get(EdgeLabels.attach) : EdgeLabels.attach;

		this.allDocumentsStmt = this.db.prepare('Select id, uri, documentHash From documents');
		this.getDocumentContentStmt = this.db.prepare('Select content From contents Where documentHash = ?');
		this.findDocumentStmt = this.db.prepare('Select id From documents Where uri = ?');

		/* eslint-disable indent */
		this.findRangesStmt = this.db.prepare([
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

		this.retrieveResultStmt = this.db.prepare([
			'Select v.id, v.label, v.value From vertices v',
			'Inner Join edges e On e.inV = v.id',
			'Where e.outV = $source and e.label = $label'
		].join(' '));

		this.retrieveResultForDocumentStmt = this.db.prepare([
			'Select v.id, v.label, v.value from vertices v',
			'Inner Join edges e On e.inV = v.id',
			'Inner Join documents d On d.id = e.outV',
			'Where d.uri = $uri and e.label = $label'
		].join(' '));

		this.retrieveNextVertexStmt = this.db.prepare([
			'Select e.inV From edges e',
			`Where e.outV = $source and e.label = ${nextLabel}`
		].join(' '));

		this.retrieveAttachMonikerStmt = this.db.prepare([
			'Select e.inV From edges e',
			`Where e.outV = $source and e.label = ${attachEdgeLabel}`
		].join(' '));

		this.retrieveMonikerStmt = this.db.prepare([
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
			'Select v.id, v.label, v.value From vertices v',
			'Inner Join edges e on v.id = e.outV',
			`Where e.inV = $target and e.label = ${attachEdgeLabel}`
		].join(' '));

		this.findVerticesForMonikerStmt = this.db.prepare([
			'Select v.id, v.label, v.value from vertices v',
			'INNER Join edges e On v.id = e.outV',
			`Where e.label = ${monikerEdgeLabel} and e.inV = $id`
		].join(' '));

		this.retrieveRangesFromResultStmt = this.db.prepare([
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

		this.findLinksFromReferenceResult = this.db.prepare([
			'Select v.id, v.label, v.value from vertices v',
			'Inner Join items i On i.inV = v.id',
			'Where i.outV = $id and i.property = 5'
		].join(' '));

		this.initialize(transformerFactory);
		return Promise.resolve();
	}

	private readMetaData(): void {
		let result: MetaDataResult[] = this.db.prepare('Select * from meta').all();
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

	private readGroup(): void {
		// take the first group
		const group: Group = this.decompress(this.db.prepare('Select v.value from vertices v Inner Join groups g On v.id = g.id').get().value);
		if (group !== undefined) {
			this.groupId = group.id;
			this.projectRoot = URI.parse(group.rootUri);
		}
	}

	public getProjectRoot(): URI {
		return this.projectRoot;
	}

	public close(): void {
		this.db.close();
	}

	protected getDocumentInfos(): DocumentInfo[] {
		let result: DocumentInfoResult[] = this.allDocumentsStmt.all();
		if (result === undefined) {
			return [];
		}
		return result.map((item) => { return { id: item.id, uri: item.uri, hash: item.documentHash }; });
	}

	protected findFile(uri: string): { id: Id, hash: string | undefined } | undefined {
		let result = this.findDocumentStmt.get(uri);
		return result;
	}

	protected fileContent(info: { id: Id, hash: string | undefined }): string {
		let result: ContentResult = this.getDocumentContentStmt.get(info.hash);
		if (!result || !result.content) {
			return '';
		}
		return Buffer.from(result.content).toString('base64');
	}

	public foldingRanges(uri: string): lsp.FoldingRange[] | undefined {
		let foldingResult = this.retrieveResultForDocument(this.toDatabase(uri), EdgeLabels.textDocument_foldingRange);
		if (foldingResult === undefined) {
			return undefined;
		}
		return foldingResult.result;
	}

	public documentSymbols(uri: string): lsp.DocumentSymbol[] | undefined {
		let symbolResult = this.retrieveResultForDocument(this.toDatabase(uri), EdgeLabels.textDocument_documentSymbol);
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
				let range: Range = this.decompress(element.value);
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
		const ranges = this.findRangesFromPosition(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const findHover = (range: RangeResult): lsp.Hover | undefined =>  {
			const hoverResult = this.getResultPath(range.id, EdgeLabels.textDocument_hover).result?.value;
			if (hoverResult === undefined) {
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
		return this.findTargets(uri, position, EdgeLabels.textDocument_declaration);
	}

	public definitions(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		return this.findTargets(uri, position, EdgeLabels.textDocument_definition);
	}

	private findTargets(uri: string, position: lsp.Position, edgeLabel: EdgeLabels.textDocument_declaration | EdgeLabels.textDocument_definition): lsp.Location | lsp.Location[] | undefined {
		const ranges = this.findRangesFromPosition(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const _findTargets = (result: DedupeArray<lsp.Location>, range: RangeResult): void => {
			const resultPath = this.getResultPath(range.id, edgeLabel);
			if (resultPath.result === undefined) {
				return undefined;
			}

			this.retrieveLocationsFromResult(result, resultPath.result.value);

			const mostSpecificMoniker = this.getClosestMoniker(resultPath);
			const monikers: DedupeArray<Moniker> = new DedupeArray<Moniker>(Monikers.makeKey);
			if (mostSpecificMoniker !== undefined) {
				monikers.push(mostSpecificMoniker);
				for (const attached of this.findAttachedMonikers(mostSpecificMoniker)) {
					monikers.push(attached);
				}
			}
			for (const moniker of monikers.value.sort()) {
				const matchingMonikers =  this.findMatchingMonikers(moniker);
				if (matchingMonikers !== undefined) {
					for (const matchingMoniker of matchingMonikers) {
						const vertices = this.findVerticesForMoniker(matchingMoniker);
						for (const vertex of vertices) {
							const resultPath = this.getResultPath(vertex.id, edgeLabel);
							if (resultPath.result === undefined) {
								continue;
							}
							this.retrieveLocationsFromResult(result, resultPath.result.value);
						}
					}
				}
			}
		};

		const result: DedupeArray<lsp.Location> = new DedupeArray<lsp.Location>(Locations.makeKey);
		for (const range of ranges) {
			_findTargets(result, range);
		}
		return result.value;
	}

	public references(uri: string, position: lsp.Position, context: lsp.ReferenceContext): lsp.Location[] | undefined {
		const ranges = this.findRangesFromPosition(this.toDatabase(uri), position);
		if (ranges === undefined) {
			return undefined;
		}

		const findReferences = (result: DedupeArray<lsp.Location>, monikers: DedupeArray<Moniker>, range: RangeResult): void => {
			const resultPath = this.getResultPath(range.id, EdgeLabels.textDocument_references);
			if (resultPath.result === undefined) {
				return undefined;
			}

			const moniker = this.getClosestMoniker(resultPath);
			if (moniker !== undefined) {
				const attachedMonikers = this.findAttachedMonikers(moniker);
				monikers.push(this.getMostUniqueMoniker(attachedMonikers.concat([moniker]))!);
			}
			this.resolveReferenceResult(result, monikers, resultPath.result.value, context);
			for (const moniker of monikers) {
				if (moniker.kind === MonikerKind.local) {
					continue;
				}
				const matchingMonikers = this.findMatchingMonikers(moniker);
				for (const matchingMoniker of matchingMonikers) {
					const vertices = this.findVerticesForMoniker(matchingMoniker);
					for (const vertex of vertices) {
						const resultPath = this.getResultPath(vertex.id, EdgeLabels.textDocument_references);
						if (resultPath.result === undefined) {
							continue;
						}
						this.resolveReferenceResult(result, monikers, resultPath.result.value, context);
					}
				}
			}
		};

		const result: DedupeArray<lsp.Location> = new DedupeArray<lsp.Location>(Locations.makeKey);
		const monikers: DedupeArray<Moniker> = new DedupeArray<Moniker>(Monikers.makeKey);
		for (const range of ranges) {
			findReferences(result, monikers, range);
		}
		return result.value;
	}

	private resolveReferenceResult(result: DedupeArray<lsp.Location>, monikers: DedupeArray<Moniker>, referenceResult: ReferenceResult, context: lsp.ReferenceContext): void {
		const qr: LocationResultWithProperty[] = this.findRangeFromReferenceResult.all({ id: referenceResult.id });
		if (qr && qr.length > 0) {
			const refLabel = this.getItemEdgeProperty(ItemEdgeProperties.references);
			for (const item of qr) {
				if (item.property === refLabel || context.includeDeclaration) {
					this.addLocation(result, item);
				}
			}
		}

		const mr: VertexResult[] = this.findLinksFromReferenceResult.all({ id: referenceResult.id });
		if (mr) {
			for (const moniker of mr) {
				monikers.push(this.decompress(moniker.value));
			}
		}

		const rqr: VertexResult[] = this.findResultFromReferenceResult.all({ id: referenceResult.id });
		if (rqr && rqr.length > 0) {
			for (const item of rqr) {
				this.resolveReferenceResult(result, monikers, this.decompress(item.value), context);
			}
		}
	}

	private getResultPath(start: Id, label: EdgeLabels.textDocument_hover): ResultPath<HoverResult>;
	private getResultPath(start: Id, label: EdgeLabels.textDocument_declaration): ResultPath<DeclarationResult>;
	private getResultPath(start: Id, label: EdgeLabels.textDocument_definition): ResultPath<DeclarationResult>;
	private getResultPath(start: Id, label: EdgeLabels.textDocument_declaration | EdgeLabels.textDocument_definition): ResultPath<DeclarationResult | DefinitionResult>;
	private getResultPath(start: Id, label: EdgeLabels.textDocument_references): ResultPath<ReferenceResult>;
	private getResultPath(start: Id, label: EdgeLabels): ResultPath<HoverResult | DeclarationResult | DeclarationResult | ReferenceResult>
	private getResultPath(start: Id, label: EdgeLabels): ResultPath<any> {
		let currentId = start;
		const result: ResultPath<any> = { path: [], result: undefined };
		do {
			const value: any | undefined = this.retrieveResult(currentId, label);
			const moniker: Moniker | undefined = this.retrieveMoniker(currentId);
			if (value !== undefined) {
				result.result = { value, moniker };
				return result;
			}
			result.path.push({ vertex: currentId, moniker });
			const next = this.retrieveNextVertexId(currentId);
			if (next === undefined) {
				return result;
			}
			currentId = next;
		} while (true);
	}

	private getClosestMoniker<T>(result: ResultPath<T>): Moniker | undefined {
		if (result.result?.moniker !== undefined) {
			return result.result.moniker;
		}
		for (let i = result.path.length - 1; i >= 0; i--) {
			if (result.path[i].moniker !== undefined) {
				return result.path[i].moniker;
			}
		}
		return undefined;
	}

	private static UniqueMapping = new Map<UniquenessLevel, number>([
		[UniquenessLevel.document, 1000],
		[UniquenessLevel.project, 2000],
		[UniquenessLevel.group, 3000],
		[UniquenessLevel.scheme, 4000],
		[UniquenessLevel.global, 5000]
	]);
	private getMostUniqueMoniker(monikers: Moniker[]): Moniker | undefined {
		if (monikers.length === 0) {
			return undefined;
		}
		let result: Moniker = monikers[0];
		for (let i = 1; i < monikers.length; i++) {
			if (GraphStore.UniqueMapping.get(monikers[i].unique)! > GraphStore.UniqueMapping.get(result.unique)!) {
				result = monikers[i];
			}
		}
		return result;
	}

	private findRangesFromPosition(uri: string, position: lsp.Position): RangeResult[] | undefined {
		let dbResult: RangeResult[] = this.findRangesStmt.all({ uri: uri, line: position.line, character: position.character});
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

	private findMatchingMonikers(moniker: Moniker): Moniker[] {
		const results: VertexResult[] = this.findMatchingMonikersStmt.all({ identifier: moniker.identifier, scheme: moniker.scheme, exclude: moniker.id });
		return results.map(vertex => this.decompress(vertex.value));
	}

	private findAttachedMonikers(moniker: Moniker): Moniker[] {
		const result: VertexResult[] = this.findAttachedMonikersStmt.all({ target: moniker.id });
		return result.map(vertext => this.decompress(vertext.value));
	}

	private findVerticesForMoniker(moniker: Moniker): VertexResult[] {
		let currentId = moniker.id;
		do {
			const target: AttachResult = this.retrieveAttachMonikerStmt.get({ source: currentId });
			if (target === undefined) {
				break;
			}
			currentId = target.inV;
		} while (true);
		return this.findVerticesForMonikerStmt.all({ id: currentId });
	}

	private retrieveResult(vertexId: Id, label: EdgeLabels.textDocument_hover): HoverResult | undefined;
	private retrieveResult(vertexId: Id, label: EdgeLabels.textDocument_declaration): DeclarationResult | undefined;
	private retrieveResult(vertexId: Id, label: EdgeLabels.textDocument_definition): DefinitionResult | undefined;
	private retrieveResult(vertexId: Id, label: EdgeLabels.textDocument_references): ReferenceResult | undefined;
	private retrieveResult(vertexId: Id, label: EdgeLabels): HoverResult | DeclarationResult | DefinitionResult | ReferenceResult | undefined;
	private retrieveResult(vertexId: Id, label: EdgeLabels): HoverResult | DeclarationResult | DefinitionResult | ReferenceResult | undefined {
		const qr: VertexResult | undefined = this.retrieveResultStmt.get({ source: vertexId, label: this.getEdgeLabel(label)});
		if (qr === undefined) {
			return undefined;
		}
		return this.decompress<HoverResult | DeclarationResult | DefinitionResult | ReferenceResult>(qr.value);
	}

	private retrieveResultForDocument(uri: string, label: EdgeLabels.textDocument_documentSymbol): DocumentSymbolResult | undefined;
	private retrieveResultForDocument(uri: string, label: EdgeLabels.textDocument_foldingRange): FoldingRangeResult | undefined;
	private retrieveResultForDocument(uri: string, label: EdgeLabels): any | undefined {
		let data: DocumentResult = this.retrieveResultForDocumentStmt.get({ uri, label: this.getEdgeLabel(label) });
		if (data === undefined) {
			return undefined;
		}
		return this.decompress(data.value);
	}

	private retrieveMoniker(vertexId: Id): Moniker | undefined {
		const qr: VertexResult | undefined = this.retrieveMonikerStmt.get({ source: vertexId });
		if (qr === undefined) {
			return undefined;
		}
		return this.decompress<Moniker>(qr.value);
	}

	private retrieveNextVertexId(vertexId: Id): Id | undefined {
		const qr: NextResult = this.retrieveNextVertexStmt.get({ source: vertexId });
		if (qr === undefined) {
			return undefined;
		}
		return qr.inV;
	}

	private retrieveLocationsFromResult(result: DedupeArray<lsp.Location>, target: DeclarationResult | DefinitionResult | ReferenceResult): void {
		const queryResult: LocationResult[] = this.retrieveRangesFromResultStmt.all({ id: target.id });
		if (queryResult && queryResult.length > 0) {
			for (const item of queryResult) {
				this.addLocation(result, item);
			}
		}
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

	private addLocation(result: DedupeArray<lsp.Location>, value: LocationResult): void {
		let location: lsp.Location = this.createLocation(value);
		result.push(location);
	}

	private asLocation(value: Range | lsp.Location): lsp.Location {
		if (lsp.Location.is(value)) {
			return { range: value.range, uri: this.fromDatabase(value.uri)};
		} else {
			const locationRetriever = new LocationRetriever(this.db, 1);
			locationRetriever.add(value.id);
			let data: LocationResult = locationRetriever.run()[0];
			return this.createLocation(data);
		}
	}

	private createLocation(data: LocationResult): lsp.Location {
		return lsp.Location.create(this.fromDatabase(data.uri), lsp.Range.create(data.startLine, data.startCharacter, data.endLine, data.endCharacter));
	}

	private decompress<T extends (Vertex | Edge)>(value: string | any[]): T {
		const compressed: any[] = typeof value === 'string' ? JSON.parse(value) : value;
		let decompressor = Decompressor.get(compressed[0]);
		if (decompressor) {
			return decompressor.decompress(compressed);
		} else {
			throw new Error(`No decompressor found for ${JSON.stringify(compressed, undefined, 0)}`);
		}
	}
}