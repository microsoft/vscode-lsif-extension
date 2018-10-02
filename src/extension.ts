'use strict';

import * as path from 'path';
import * as fs from 'fs';

import * as vscode from 'vscode';

import * as lsp from 'vscode-languageserver-protocol';
import { createConverter } from 'vscode-languageclient/lib/protocolConverter';

import { Id, Vertex, Project, Document, Range, DiagnosticResult, DocumentSymbolResult, FoldingRangeResult, DocumentLinkResult, DefinitionResult, TypeDefinitionResult, HoverResult, ReferenceResult, ImplementationResult, Edge } from './protocol';
import { Location } from 'vscode-languageserver-protocol';

interface Vertices {
	all: Map<Id, Vertex>;
	projects: Map<Id, Project>;
	documents: Map<Id, Document>;
	ranges: Map<Id, Range>;
}

interface Out {
	contains: Map<Id, Document[] | Range[]>;
	item: Map<Id, ({ type: 'declaration'; range: Range } | { type: 'reference'; range: Range } | { type: 'referenceResult'; result: ReferenceResult })[]>
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

interface Indices {
	documents: Map<string, Document>;
}

class SipDatabase {

	private vertices: Vertices;
	private indices: Indices;
	private out: Out;

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
			case 'range':
				this.vertices.ranges.set(vertex.id, vertex);
				break;
		}
	}

	private processEdge(edge: Edge): void {
		let to: Vertex | undefined;
		let values: any[] | undefined;
		switch (edge.label) {
			case 'contains':
				to = this.vertices.all.get(edge.outV);
				if (to === void 0) {
					throw new Error(`No vertex found for Id ${edge.outV}`);
				}
				values = this.out.contains.get(edge.inV);
				if (values === void 0) {
					values = [ to as any ];
					this.out.contains.set(edge.inV, values);
				} else {
					values.push(to);
				}
				break;
			case 'item':
				to = this.vertices.all.get(edge.outV);
				if (to === void 0) {
					throw new Error(`No vertex found for Id ${edge.outV}`);
				}
				values = this.out.item.get(edge.inV);
				if (values === void 0) {
					values = [ to as any ];
					this.out.item.set(edge.inV, values);
				} else {
					values.push(to);
				}
				break;
				break;
			case 'textDocument/documentSymbol':
				this.storeEdge(edge, this.out.documentSymbol);
				break;
			case 'textDocument/foldingRange':
				this.storeEdge(edge, this.out.foldingRange);
				break;
			case 'textDocument/documentLink':
				this.storeEdge(edge, this.out.documentLink);
				break;
			case 'textDocument/diagnostic':
				this.storeEdge(edge, this.out.diagnostic);
				break;
			case 'textDocument/definition':
				this.storeEdge(edge, this.out.definition);
				break;
			case 'textDocument/typeDefinition':
				this.storeEdge(edge, this.out.typeDefinition);
				break;
			case 'textDocument/hover':
				this.storeEdge(edge, this.out.hover);
				break;
			case 'textDocument/references':
				this.storeEdge(edge, this.out.references);
				break;
		}
	}

	private storeEdge(edge: Edge, outMap: Map<Id, Vertex>): void {
		let to = this.vertices.all.get(edge.outV);
		if (to === void 0) {
			throw new Error(`No vertex found for Id ${edge.outV}`);
		}
		outMap.set(edge.outV, to);
	}

	public findRange(file: string, position: vscode.Position): Range | undefined {
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

	// public containedIn(vertex: SymbolDeclaration | SymbolReference | Location | undefined): Document | undefined {
	// 	if (vertex === void 0) {
	// 		return void 0;
	// 	}
	// 	let result = this.in.contains.get(vertex._id);
	// 	if (result === void 0 || result.length !== 1) {
	// 		return undefined;
	// 	}
	// 	let item = result[0];
	// 	return item._kind === 'document' ? item : undefined;
	// }

	public definitions(vertex: Range | undefined): Location[] | undefined {
		if (vertex === void 0) {
			return undefined;
		}
		let result: SymbolDeclaration[] | undefined = this.out.definition.get(vertex._id);
		return result ? result : undefined;
	}

	public hover(vertex: SymbolDeclaration | SymbolReference | Location | undefined): Hover | undefined {
		if (vertex === void 0) {
			return undefined;
		}
		const getHover = (vertex: SymbolDeclaration | SymbolReference | Location): Hover | undefined => {
			let result: Hover[] | undefined = this.out.hover.get(vertex._id);
			return result ? result[0] : undefined;
		}
		let result = getHover(vertex);
		if (result === void 0 && (vertex._kind === 'symbolReference' || vertex._kind === 'location')) {
			let declaration = this.definitions(vertex);
			if (declaration) {
				result = getHover(declaration[0]);
			}
		}
		return result;
	}

	public references(vertex: SymbolDeclaration | SymbolReference | Location | undefined): LocationLike[] | undefined {
		if (vertex === void 0) {
			return undefined;
		}

		let toProcess: LocationLike[] = [];
		// We have a location or a refernce with no recorded references. Go check the declaration.
		if (!this.out.reference.has(vertex._id) && vertex._kind !== 'symbolDeclaration') {
			let declarations = this.definitions(vertex);
			if (declarations === void 0 || declarations.length === 0) {
				return undefined;
			}
			toProcess = declarations;
		} else {
			toProcess = [ vertex ];
		}

		let result: LocationLike[] = [];
		const processResultSet = (set: ReferenceSet): void => {
			let items = this.out.item.get(set._id);
			if (items !== void 0) {
				result.push(...items);
			}
			let sets = this.out.set.get(set._id);
			if (sets !== void 0) {
				// ToDo check type / request
				sets.forEach((item) => processResultSet(item as ReferenceSet));
			}
		}

		for (let item of toProcess) {
			let references = this.out.reference.get(item._id);
			if (references === void 0 || references.length === 0) {
				continue;
			}
			for (let reference of references) {
				switch (reference._kind) {
					case 'symbolDeclaration':
						result.push(reference);
						break;
					case 'symbolReference':
						result.push(reference);
						break;
					case 'location':
						result.push(reference);
						break;
					case 'set':
						// ToDo check type / request
						processResultSet(reference as ReferenceSet);
						break;
				}
			}
		}
		return result;
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

	const converter = createConverter();

	const makeLocation = (vertex: LocationLike): vscode.Location | undefined => {
		let document = database.containedIn(vertex);
		if (document === void 0) {
			return undefined;
		}
		return new vscode.Location(vscode.Uri.parse(document.uri), converter.asRange(vertex.range));
	}

	let selector: vscode.DocumentSelector = { scheme: 'file', language: 'typescript', exclusive: true }  as vscode.DocumentSelector;
	vscode.languages.registerDefinitionProvider(selector as vscode.DocumentSelector, {
		provideDefinition: (document, position) => {
			let range = database.findRange(document.uri.fsPath, position);
			if (range === void 0) {
				return undefined;
			}
			@@ Got Defintion link is necessary on definition as well.



			if (range.label === 'symbolDeclaration') {
				return makeLocation(range);
			}
			let definitions = database.definitions(range);
			if (definitions === void 0) {
				return undefined;
			}
			let result: vscode.Location[] = [];
			for (let declaration of definitions) {
				let loc = makeLocation(declaration);
				if (loc !== void 0) {
					result.push(loc);
				}
			}
			return result;
		}
	});

	vscode.languages.registerHoverProvider(selector, {
		provideHover: (document, position) => {
			let vertex = database.findRange(document.uri.fsPath, position);
			if (vertex === void 0) {
				return undefined;
			}

			let hover = database.hover(vertex);
			if (hover === void 0) {
				return undefined;
			}
			return converter.asHover(hover);
		}
	});

	vscode.languages.registerReferenceProvider(selector, {
		provideReferences: (document, positions) => {
			let vertex = database.findRange(document.uri.fsPath, positions);
			if (vertex === void 0) {
				return undefined;
			}
			let references = database.references(vertex);
			if (references === void 0) {
				return undefined;
			}
			let result: vscode.Location[] = [];
			for (let reference of references) {
				let loc = makeLocation(reference);
				if (loc !== void 0) {
					result.push(loc);
				}
			}
			return result;
		}
	})
}

// this method is called when your extension is deactivated
export function deactivate() {
}