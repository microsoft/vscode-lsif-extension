/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';
import * as fs from 'fs';

import * as vscode from 'vscode';

import * as lsp from 'vscode-languageserver-protocol';
import { createConverter, Converter } from 'vscode-languageclient/lib/protocolConverter';

import { Id, Vertex, Project, Document, Range, DiagnosticResult, DocumentSymbolResult, FoldingRangeResult, DocumentLinkResult, DefinitionResult, TypeDefinitionResult, HoverResult, ReferenceResult, ImplementationResult, Edge, RangeBasedDocumentSymbol } from './protocol';

interface Vertices {
	all: Map<Id, Vertex>;
	projects: Map<Id, Project>;
	documents: Map<Id, Document>;
	ranges: Map<Id, Range>;
}

type ItemTarget = { type: 'declaration'; range: Range } | { type: 'reference'; range: Range } | { type: 'referenceResult'; result: ReferenceResult };

interface Out {
	contains: Map<Id, Document[] | Range[]>;
	item: Map<Id, ItemTarget[]>
	documentSymbol: Map<Id, DocumentSymbolResult>;
	foldingRange: Map<Id, FoldingRangeResult>;
	documentLink: Map<Id, DocumentLinkResult>;
	diagnostic: Map<Id, DiagnosticResult>;
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
	referenceResults: ReferenceResult[];
}

class SipDatabase {

	private vertices: Vertices;
	private indices: Indices;
	private out: Out;
	private in: In;

	private converter: Converter;

	constructor(private file: string) {
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
			documentSymbol: new Map(),
			foldingRange: new Map(),
			documentLink: new Map(),
			diagnostic: new Map(),
			definition: new Map(),
			typeDefinition: new Map(),
			hover: new Map(),
			references: new Map(),
			implementation: new Map()
		};

		this.in = {
			contains: new Map()
		}

		this.converter = createConverter();
	}

	public load(): void {
		let json: (Vertex | Edge)[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		for (let item of json) {
			switch (item.type) {
				case 'vertex':
					this.processVertex(item);
					break;
				case 'edge':
					this.processEdge(item);
					break;
			}
		}
	}

	private processVertex(vertex: Vertex): void {
		this.vertices.all.set(vertex.id, vertex);
		switch(vertex.label) {
			case 'project':
				this.vertices.projects.set(vertex.id, vertex);
				break;
			case 'document':
				this.vertices.documents.set(vertex.id, vertex);
				this.indices.documents.set(vscode.Uri.parse(vertex.uri).fsPath, vertex);
				break;
			case 'range':
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
			case 'contains':
				values = this.out.contains.get(from.id);
				if (values === void 0) {
					values = [ to as any ];
					this.out.contains.set(from.id, values);
				} else {
					values.push(to);
				}
				this.in.contains.set(to.id, from as any);
				break;
			case 'item':
				values = this.out.item.get(from.id);
				let itemTarget: ItemTarget | undefined;
				switch (edge.property) {
					case 'reference':
						itemTarget = { type: edge.property, range: to as Range };
						break;
					case 'declaration':
						itemTarget = { type: edge.property, range: to as Range };
						break;
					case 'referenceResult':
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
			case 'textDocument/documentSymbol':
				this.out.documentSymbol.set(from.id, to as DocumentSymbolResult);
				break;
			case 'textDocument/foldingRange':
				this.out.foldingRange.set(from.id, to as FoldingRangeResult);
				break;
			case 'textDocument/documentLink':
				this.out.documentLink.set(from.id, to as DocumentLinkResult);
				break;
			case 'textDocument/diagnostic':
				this.out.diagnostic.set(from.id, to as DiagnosticResult);
				break;
			case 'textDocument/definition':
				this.out.definition.set(from.id, to as DefinitionResult);
				break;
			case 'textDocument/typeDefinition':
				this.out.typeDefinition.set(from.id, to as TypeDefinitionResult);
				break;
			case 'textDocument/hover':
				this.out.hover.set(from.id, to as HoverResult);
				break;
			case 'textDocument/references':
				this.out.references.set(from.id, to as ReferenceResult);
				break;
		}
	}

	public foldingRanges(d: vscode.TextDocument): vscode.FoldingRange[] | undefined {
		let document = this.indices.documents.get(d.uri.fsPath);
		if (document === void 0) {
			return undefined;
		}
		let foldingRangeResult = this.out.foldingRange.get(document.id);
		if (foldingRangeResult === void 0) {
			return undefined;
		}
		let result: vscode.FoldingRange[] = [];
		for (let item of foldingRangeResult.result) {
			result.push(this.converter.asFoldingRange(item));
		}
		return result;
	}

	public documentSymbols(d: vscode.TextDocument): vscode.DocumentSymbol[] | undefined {
		let document = this.indices.documents.get(d.uri.fsPath);
		if (document === void 0) {
			return undefined;
		}
		let documentSymbolResult = this.out.documentSymbol.get(document.id);
		if (documentSymbolResult === void 0 || documentSymbolResult.result.length === 0) {
			return undefined;
		}
		let first = documentSymbolResult.result[0];
		if (lsp.DocumentSymbol.is(first)) {
			return this.converter.asDocumentSymbols(documentSymbolResult.result as lsp.DocumentSymbol[]);
		} else {
			let result: vscode.DocumentSymbol[] = [];
			for (let item of (documentSymbolResult.result as RangeBasedDocumentSymbol[])) {
				let converted = this.toDocumentSymbol(item);
				if (converted !== void 0) {
					result.push(converted);
				}
			}
			return result;
		}
	}

	private toDocumentSymbol(value: RangeBasedDocumentSymbol): vscode.DocumentSymbol | undefined {
		let range = this.vertices.ranges.get(value.id)!;
		let tag = range.tag;
		if (tag === void 0 || tag.type !== 'declaration') {
			return undefined;
		}
		let result: vscode.DocumentSymbol = new vscode.DocumentSymbol(
			tag.text, tag.detail || '', tag.kind - 1,
			this.converter.asRange(tag.fullRange),
			this.converter.asRange(range));
		if (value.children && value.children.length > 0) {
			for (let child of value.children) {
				let converted = this.toDocumentSymbol(child);
				if (converted !== void 0) {
					result.children.push(converted);
				}
			}
		}
		return result;
	}

	public definitions(document: vscode.TextDocument, position: vscode.Position): vscode.Location | vscode.Location[] | undefined {
		let range = this.findRangeFromPosition(document.uri.fsPath, position);
		if (range === void 0) {
			return undefined;
		}
		let definitionResult: DefinitionResult | undefined = this.out.definition.get(range.id);
		if (definitionResult === void 0) {
			return undefined;
		}
		if (Array.isArray(definitionResult.result)) {
			let result: vscode.Location[] = [];
			for (let element of definitionResult.result) {
				result.push(this.asLocation(element));
			}
			return result;
		} else {
			return this.asLocation(definitionResult.result);
		}
	}

	public hover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		let range = this.findRangeFromPosition(document.uri.fsPath, position);
		if (range === void 0) {
			return undefined;
		}

		let hoverResult: HoverResult | undefined = this.out.hover.get(range.id);
		if (hoverResult === void 0) {
			let definition = this.findDefinition(range);
			if (definition) {
				hoverResult = this.out.hover.get(definition.id);
			}
		}
		if (hoverResult === void 0) {
			return undefined;
		}

		let hoverRange = hoverResult.result.range === '${startRange}' ? range : hoverResult.result.range;
		return this.converter.asHover(Object.assign({}, { contents: hoverResult.result.contents }, { range: hoverRange }))
	}

	public references(document: vscode.TextDocument, position: vscode.Position, context: vscode.ReferenceContext): vscode.Location[] | undefined {
		let range = this.findRangeFromPosition(document.uri.fsPath, position);
		if (range === void 0) {
			return undefined;
		}

		let referenceResult: ReferenceResult | undefined = this.out.references.get(range.id);
		if (referenceResult === void 0) {
			let definition = this.findDefinition(range);
			if (definition) {
				referenceResult = this.out.references.get(definition.id);
			}
		}
		if (referenceResult === void 0) {
			return undefined;
		}

		return this.asReferenceResult(referenceResult, context, new Set());
	}

	private asReferenceResult(value: ReferenceResult, context: vscode.ReferenceContext, dedup: Set<Id>): vscode.Location[] | undefined {
		let resolved = this.resolveReferenceResult(value, context.includeDeclaration);
		let result: vscode.Location[] = [];
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
			referenceResults = [];
			let targets = this.out.item.get(value.id);
			if (targets) {
				for (let target of targets) {
					switch (target.type) {
						case 'reference':
							references.push(target.range);
							break;
						case 'declaration':
							declarations.push(target.range);
							break;
						case 'referenceResult':
							referenceResults.push(target.result);
							break;
					}
				}
			}
		}
		return {
			references: references || [],
			declarations: declarations || [],
			referenceResults: referenceResults || []
		};
	}

	private addLocation(result: vscode.Location[], value: Range | lsp.Location, dedup: Set<Id>): void {
		if (lsp.Location.is(value)) {
			result.push(this.converter.asLocation(value));
		} else {
			if (dedup.has(value.id)) {
				return;
			}
			let document = this.in.contains.get(value.id)!;
			result.push(new vscode.Location(vscode.Uri.parse((document as Document).uri), this.converter.asRange(value)));
			dedup.add(value.id);
		}
	}

	private asLocation(value: Id | lsp.Location): vscode.Location {
		if (lsp.Location.is(value)) {
			return this.converter.asLocation(value);
		} else {
			let range = this.vertices.ranges.get(value)!;
			let document = this.in.contains.get(range.id)!;
			return new vscode.Location(vscode.Uri.parse((document as Document).uri), this.converter.asRange(range));
		}
	}

	private findDefinition(range: Range): Range | undefined {
		let definitionResult = this.out.definition.get(range.id);
		if (definitionResult === void 0) {
			return undefined;
		}
		let element: Id | lsp.Location | undefined;
		if (Array.isArray(definitionResult.result)) {
			if (definitionResult.result.length > 0) {
				element = definitionResult.result[0];
			}
		} else {
			element = definitionResult.result;
		}
		if (element === void 0) {
			return undefined;
		}
		if (lsp.Location.is(element)) {
			return this.findRangeFromRange(vscode.Uri.parse(element.uri).fsPath, element.range);
		} else {
			return this.vertices.ranges.get(element);
		}
	}

	private findRangeFromPosition(file: string, position: vscode.Position): Range | undefined {
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
			if (item.label === 'document') {
				continue;
			}
			let range = item;
			if (SipDatabase.containsPosition(range, position)) {
				if (!candidate) {
					candidate = item;
				} else {
					if (SipDatabase.containsRange(candidate, range)) {
						candidate = item;
					}
				}
			}
		}
		return candidate;
	}

	private findRangeFromRange(file: string, range: lsp.Range): Range | undefined {
		let document = this.indices.documents.get(file);
		if (document === void 0) {
			return undefined;
		}
		let contains = this.out.contains.get(document.id);
		if (contains === void 0 || contains.length === 0) {
			return undefined;
		}
		for (let item of contains) {
			if (item.label === 'document') {
				continue;
			}
			if (range.start.line === item.start.line && range.start.character === item.start.character && range.end.line === item.end.line && range.end.character === item.end.character) {
				return item;
			}
		}
		return undefined;

	}

	private static containsPosition(range: lsp.Range, position: vscode.Position): boolean {
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

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	if (vscode.workspace.workspaceFolders === void 0) {
		return;
	}

	let folder = vscode.workspace.workspaceFolders[0];
	if (folder === void 0) {
		return;
	}

	let sipFile = path.join(folder.uri.fsPath, 'sip.json');
	if (!fs.existsSync(sipFile)) {
		return;
	}

	const database = new SipDatabase(sipFile);
	database.load();

	let selector: vscode.DocumentSelector = { scheme: 'file', language: 'typescript', exclusive: true }  as vscode.DocumentSelector;
	vscode.languages.registerFoldingRangeProvider(selector, {
		provideFoldingRanges: (document) => {
			return database.foldingRanges(document);
		}
	});

	vscode.languages.registerDocumentSymbolProvider(selector, {
		provideDocumentSymbols: (document) => {
			return database.documentSymbols(document);
		}
	});

	vscode.languages.registerDefinitionProvider(selector, {
		provideDefinition: (document, position) => {
			return database.definitions(document, position);
		}
	});

	vscode.languages.registerHoverProvider(selector, {
		provideHover: (document, position) => {
			return database.hover(document, position);
		}
	});

	vscode.languages.registerReferenceProvider(selector, {
		provideReferences: (document, position, context) => {
			return database.references(document, position, context);
		}
	})
}

// this method is called when your extension is deactivated
export function deactivate() {
}