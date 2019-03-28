/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';

import URI from 'vscode-uri';

import * as lsp from 'vscode-languageserver';

import { Id, Vertex, Project, Document, Range, DiagnosticResult, DocumentSymbolResult, FoldingRangeResult, DocumentLinkResult, DefinitionResult, TypeDefinitionResult, HoverResult, ReferenceResult, ImplementationResult, Edge, RangeBasedDocumentSymbol, DeclarationResult, ResultSet, ElementTypes, VertexLabels, EdgeLabels, ItemEdgeProperties } from './protocol';
import { FileType, DocumentInfo, FileStat } from './files';
import { Database } from './database';

interface Vertices {
	all: Map<Id, Vertex>;
	projects: Map<Id, Project>;
	documents: Map<Id, Document>;
	ranges: Map<Id, Range>;
}

type ItemTarget =
	{ type: ItemEdgeProperties.declaration; range: Range; } |
	{ type: ItemEdgeProperties.definition; range: Range; } |
	{ type: ItemEdgeProperties.reference; range: Range; } |
	{ type: ItemEdgeProperties.referenceResults; result: ReferenceResult; };

interface Out {
	contains: Map<Id, Document[] | Range[]>;
	item: Map<Id, ItemTarget[]>;
	refersTo: Map<Id, ResultSet>;
	documentSymbol: Map<Id, DocumentSymbolResult>;
	foldingRange: Map<Id, FoldingRangeResult>;
	documentLink: Map<Id, DocumentLinkResult>;
	diagnostic: Map<Id, DiagnosticResult>;
	declaration: Map<Id, DeclarationResult>;
	definition: Map<Id, DefinitionResult>;
	typeDefinition: Map<Id, TypeDefinitionResult>;
	hover: Map<Id, HoverResult>;
	references: Map<Id, ReferenceResult>;
	implementation: Map<Id, ImplementationResult>;
}

interface In {
	contains: Map<Id, Project | Document>;
}

interface Indices {
	documents: Map<string, Document>;
}

interface ResolvedReferenceResult {
	references: (Range | lsp.Location)[];
	declarations: (Range | lsp.Location)[];
	definitions: (Range | lsp.Location)[];
	referenceResults: ReferenceResult[];
}

export class JsonDatabase extends Database {

	private version: string | undefined;
	private vertices: Vertices;
	private indices: Indices;
	private out: Out;
	private in: In;

	constructor(private file: string) {
		super();
		this.vertices = {
			all: new Map(),
			projects: new Map(),
			documents: new Map(),
			ranges: new Map()
		};

		this.indices = {
			documents: new Map()
		};

		this.out = {
			contains: new Map(),
			item: new Map(),
			refersTo: new Map(),
			documentSymbol: new Map(),
			foldingRange: new Map(),
			documentLink: new Map(),
			diagnostic: new Map(),
			declaration: new Map(),
			definition: new Map(),
			typeDefinition: new Map(),
			hover: new Map(),
			references: new Map(),
			implementation: new Map()
		};

		this.in = {
			contains: new Map()
		}
	}

	public load(): void {
		let json: (Vertex | Edge)[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		for (let item of json) {
			switch (item.type) {
				case ElementTypes.vertex:
					this.processVertex(item);
					break;
				case ElementTypes.edge:
					this.processEdge(item);
					break;
			}
		}
		if (this.version && this.version !== '0.1.0') {
			throw new Error(`Unsupported version  ${this.version}`);
		}
	}

	public close(): void {

	}

	private processVertex(vertex: Vertex): void {
		this.vertices.all.set(vertex.id, vertex);
		switch(vertex.label) {
			case VertexLabels.metaData:
				this.version = vertex.version;
				break;
			case VertexLabels.project:
				this.vertices.projects.set(vertex.id, vertex);
				break;
			case VertexLabels.document:
				this.vertices.documents.set(vertex.id, vertex);
				this.indices.documents.set(vertex.uri, vertex);
				break;
			case VertexLabels.range:
				this.vertices.ranges.set(vertex.id, vertex);
				break;
		}
	}

	private processEdge(edge: Edge): void {
		let from: Vertex | undefined = this.vertices.all.get(edge.outV);
		let to: Vertex | undefined = this.vertices.all.get(edge.inV);
		if (from === void 0) {
			throw new Error(`No vertex found for Id ${edge.outV}`);
		}
		if (to === void 0) {
			throw new Error(`No vertex found for Id ${edge.inV}`);
		}
		let values: any[] | undefined;
		switch (edge.label) {
			case EdgeLabels.contains:
				values = this.out.contains.get(from.id);
				if (values === void 0) {
					values = [ to as any ];
					this.out.contains.set(from.id, values);
				} else {
					values.push(to);
				}
				this.in.contains.set(to.id, from as any);
				break;
			case EdgeLabels.item:
				values = this.out.item.get(from.id);
				let itemTarget: ItemTarget | undefined;
				switch (edge.property) {
					case ItemEdgeProperties.reference:
						itemTarget = { type: edge.property, range: to as Range };
						break;
					case ItemEdgeProperties.declaration:
						itemTarget = { type: edge.property, range: to as Range };
						break;
					case ItemEdgeProperties.definition:
						itemTarget = { type: edge.property, range: to as Range };
						break;
					case ItemEdgeProperties.referenceResults:
						itemTarget = { type: edge.property, result: to as ReferenceResult };
						break;
				}
				if (itemTarget !== void 0) {
					if (values === void 0) {
						values = [ itemTarget ];
						this.out.item.set(from.id, values);
					} else {
						values.push(itemTarget);
					}
				}
				break;
			case EdgeLabels.refersTo:
				this.out.refersTo.set(from.id, to as ResultSet);
				break;
			case EdgeLabels.textDocument_documentSymbol:
				this.out.documentSymbol.set(from.id, to as DocumentSymbolResult);
				break;
			case EdgeLabels.textDocument_foldingRange:
				this.out.foldingRange.set(from.id, to as FoldingRangeResult);
				break;
			case EdgeLabels.textDocument_documentLink:
				this.out.documentLink.set(from.id, to as DocumentLinkResult);
				break;
			case EdgeLabels.textDocument_diagnostic:
				this.out.diagnostic.set(from.id, to as DiagnosticResult);
				break;
			case EdgeLabels.textDocument_definition:
				this.out.definition.set(from.id, to as DefinitionResult);
				break;
			case EdgeLabels.textDocument_typeDefinition:
				this.out.typeDefinition.set(from.id, to as TypeDefinitionResult);
				break;
			case EdgeLabels.textDocument_hover:
				this.out.hover.set(from.id, to as HoverResult);
				break;
			case EdgeLabels.textDocument_references:
				this.out.references.set(from.id, to as ReferenceResult);
				break;
		}
	}

	public stat(uri: string): FileStat | null {
		return null;
	}

	public readDirectory(uri: string): [string, FileType][] {
		return [];
	}

	public readFileContent(uri: string): string {
		return '';
	}

	public getDocumentInfos(): DocumentInfo[] {
		return [];
	}

	public foldingRanges(uri: string): lsp.FoldingRange[] | undefined {
		let document = this.indices.documents.get(uri);
		if (document === void 0) {
			return undefined;
		}
		let foldingRangeResult = this.out.foldingRange.get(document.id);
		if (foldingRangeResult === void 0) {
			return undefined;
		}
		let result: lsp.FoldingRange[] = [];
		for (let item of foldingRangeResult.result) {
			result.push(Object.assign(Object.create(null), item));
		}
		return result;
	}

	public documentSymbols(uri: string): lsp.DocumentSymbol[] | undefined {
		let document = this.indices.documents.get(uri);
		if (document === void 0) {
			return undefined;
		}
		let documentSymbolResult = this.out.documentSymbol.get(document.id);
		if (documentSymbolResult === void 0 || documentSymbolResult.result.length === 0) {
			return undefined;
		}
		let first = documentSymbolResult.result[0];
		let result: lsp.DocumentSymbol[] = [];
		if (lsp.DocumentSymbol.is(first)) {
			for (let item of documentSymbolResult.result) {
				result.push(Object.assign(Object.create(null), item));
			}
		} else {
			for (let item of (documentSymbolResult.result as RangeBasedDocumentSymbol[])) {
				let converted = this.toDocumentSymbol(item);
				if (converted !== void 0) {
					result.push(converted);
				}
			}
		}
		return result;
	}

	private toDocumentSymbol(value: RangeBasedDocumentSymbol): lsp.DocumentSymbol | undefined {
		let range = this.vertices.ranges.get(value.id)!;
		let tag = range.tag;
		if (tag === void 0 || !(tag.type === 'declaration' || tag.type === 'definition')) {
			return undefined;
		}
		let result: lsp.DocumentSymbol = lsp.DocumentSymbol.create(
			tag.text, tag.detail || '', tag.kind,
			tag.fullRange, this.asRange(range)
		)
		if (value.children && value.children.length > 0) {
			result.children = [];
			for (let child of value.children) {
				let converted = this.toDocumentSymbol(child);
				if (converted !== void 0) {
					result.children.push(converted);
				}
			}
		}
		return result;
	}

	public definitions(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined {
		let range = this.findRangeFromPosition(uri, position);
		if (range === void 0) {
			return undefined;
		}
		let definitionResult: DefinitionResult | undefined = this.getResult(range, this.out.definition);
		if (definitionResult === void 0) {
			return undefined;
		}
		if (Array.isArray(definitionResult.result)) {
			let result: lsp.Location[] = [];
			for (let element of definitionResult.result) {
				result.push(this.asLocation(element));
			}
			return result;
		} else {
			return this.asLocation(definitionResult.result);
		}
	}

	public hover(uri: string, position: lsp.Position): lsp.Hover | undefined {
		let range = this.findRangeFromPosition(uri, position);
		if (range === void 0) {
			return undefined;
		}

		let hoverResult: HoverResult | undefined = this.getResult(range, this.out.hover);
		if (hoverResult === void 0) {
			return undefined;
		}

		let hoverRange = hoverResult.result.range !== undefined ? hoverResult.result.range : range;
		return {
			contents: hoverResult.result.contents,
			range: hoverRange
		};
	}

	public references(uri: string, position: lsp.Position, context: lsp.ReferenceContext): lsp.Location[] | undefined {
		let range = this.findRangeFromPosition(uri, position);
		if (range === void 0) {
			return undefined;
		}

		let referenceResult: ReferenceResult | undefined = this.getResult(range, this.out.references);
		if (referenceResult === void 0) {
			return undefined;
		}

		return this.asReferenceResult(referenceResult, context, new Set());
	}

	private getResult<T>(range: Range, edges: Map<Id, T>): T | undefined {
		let result: T | undefined = edges.get(range.id);
		if (result !== undefined) {
			return result;
		}
		let resultSet = this.out.refersTo.get(range.id);
		if (resultSet === undefined) {
			return undefined;
		}
		return edges.get(resultSet.id);
	}

	private asReferenceResult(value: ReferenceResult, context: lsp.ReferenceContext, dedup: Set<Id>): lsp.Location[] | undefined {
		let resolved = this.resolveReferenceResult(value, context.includeDeclaration);
		let result: lsp.Location[] = [];
		if (resolved.references !== void 0) {
			for (let item of resolved.references) {
				this.addLocation(result, item, dedup);
			}
		}
		if (resolved.declarations !== void 0) {
			for (let item of resolved.declarations) {
				this.addLocation(result, item, dedup);
			}
		}
		if (resolved.definitions !== void 0) {
			for (let item of resolved.definitions) {
				this.addLocation(result, item, dedup);
			}
		}
		if (value.referenceResults !== void 0) {
			for (let item of value.referenceResults) {
				let childReferenceResult = this.vertices.all.get(item) as ReferenceResult;
				if (childReferenceResult !== void 0) {
					let childReferences = this.asReferenceResult(childReferenceResult, context, dedup);
					if (childReferences !== void 0) {
						result.push(...childReferences);
					}
				}
			}
		}
		return result;
	}

	private resolveReferenceResult(value: ReferenceResult, includeDeclaration: boolean): ResolvedReferenceResult {
		let references: (Range | lsp.Location)[] | undefined;
		if (value.references !== void 0) {
			references = [];
			for (let item of value.references) {
				if (lsp.Location.is(item)) {
					references.push(item);
				} else {
					let range = this.vertices.ranges.get(item);
					range !== void 0 && references.push(range);
				}
			}
		}
		let declarations: (Range | lsp.Location)[] | undefined;
		if (includeDeclaration && value.declarations !== void 0) {
			declarations = [];
			for (let item of value.declarations) {
				if (lsp.Location.is(item)) {
					declarations.push(item);
				} else {
					let range = this.vertices.ranges.get(item);
					range !== void 0 && declarations.push(range);
				}
			}
		}
		let definitions: (Range | lsp.Location)[] | undefined;
		if (includeDeclaration && value.definitions !== void 0) {
			definitions = [];
			for (let item of value.definitions) {
				if (lsp.Location.is(item)) {
					definitions.push(item);
				} else {
					let range = this.vertices.ranges.get(item);
					range !== void 0 && definitions.push(range);
				}
			}
		}
		let referenceResults: ReferenceResult[] | undefined;
		if (value.referenceResults) {
			referenceResults = [];
			for (let item of value.referenceResults) {
				let result = this.vertices.all.get(item) as ReferenceResult;
				result && referenceResults.push(result);
			}
		}
		if (references === void 0 && declarations === void 0 && referenceResults === void 0) {
			references = [];
			declarations = [];
			definitions = [];
			referenceResults = [];
			let targets = this.out.item.get(value.id);
			if (targets) {
				for (let target of targets) {
					switch (target.type) {
						case ItemEdgeProperties.reference:
							references.push(target.range);
							break;
						case ItemEdgeProperties.declaration:
							declarations.push(target.range);
						case ItemEdgeProperties.definition:
							definitions.push(target.range);
							break;
						case ItemEdgeProperties.referenceResults:
							referenceResults.push(target.result);
							break;
					}
				}
			}
		}
		return {
			references: references || [],
			declarations: declarations || [],
			definitions: definitions || [],
			referenceResults: referenceResults || []
		};
	}

	private addLocation(result: lsp.Location[], value: Range | lsp.Location, dedup: Set<Id>): void {
		if (lsp.Location.is(value)) {
			result.push(value);
		} else {
			if (dedup.has(value.id)) {
				return;
			}
			let document = this.in.contains.get(value.id)!;
			result.push(lsp.Location.create((document as Document).uri, this.asRange(value)));
			dedup.add(value.id);
		}
	}

	private findRangeFromPosition(file: string, position: lsp.Position): Range | undefined {
		let document = this.indices.documents.get(file);
		if (document === void 0) {
			return undefined;
		}
		let contains = this.out.contains.get(document.id);
		if (contains === void 0 || contains.length === 0) {
			return undefined;
		}

		let candidate: Range | undefined;
		for (let item of contains) {
			if (item.label !== VertexLabels.range) {
				continue;
			}
			let range = item;
			if (JsonDatabase.containsPosition(range, position)) {
				if (!candidate) {
					candidate = item;
				} else {
					if (JsonDatabase.containsRange(candidate, range)) {
						candidate = item;
					}
				}
			}
		}
		return candidate;
	}

	private asLocation(value: Id | lsp.Location): lsp.Location {
		if (lsp.Location.is(value)) {
			return value;
		} else {
			let range = this.vertices.ranges.get(value)!;
			let document = this.in.contains.get(range.id)!;
			return lsp.Location.create((document as Document).uri, this.asRange(range));
		}
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