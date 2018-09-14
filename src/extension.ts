'use strict';

import * as path from 'path';
import * as fs from 'fs';

import * as vscode from 'vscode';

import * as lsp from 'vscode-languageserver-protocol';
import { createConverter } from 'vscode-languageclient/lib/protocolConverter';

import { Id, Vertex, Project, Document, Diagnostic, SymbolDeclaration, SymbolReference, Hover, Location, ResultSet, LocationLike, Edge, ReferenceSet } from './protocol';


interface Vertices {
	all: Map<Id, Vertex>;
	projects: Map<Id, Project>;
	documents: Map<Id, Document>;
	diagnostics: Map<Id, Diagnostic>;
	symbolDeclarations: Map<Id, SymbolDeclaration>;
	symbolReferences: Map<Id, SymbolReference>;
	hovers: Map<Id, Hover>;
	locations: Map<Id, Location>;
	sets: Map<Id, ResultSet<any>>;
}

interface Out {
	all: Map<Id, Vertex[]>;
	contains: Map<Id, (Document | LocationLike)[]>;
	definition: Map<Id, SymbolDeclaration[]>;
	hover: Map<Id, Hover[]>;
	reference: Map<Id, (ResultSet<'textDocument/references'> | LocationLike)[]>;
	item: Map<Id, LocationLike[]>;
	set: Map<Id, ResultSet<any>[]>;
}

interface In {
	all: Map<Id, Vertex[]>;
	contains: Map<Id, (Document | Project)[]>;
	definition: Map<Id, SymbolReference[]>;
	hover: Map<Id, (SymbolDeclaration | SymbolReference | Location)[]>;
}

interface Indices {
	documents: Map<string, Document>;
}

class SipDatabase {

	private vertices: Vertices;
	private indices: Indices;
	private out: Out;
	private in: In;

	constructor(private file: string) {
		this.vertices = {
			all: new Map(),
			projects: new Map(),
			documents: new Map(),
			diagnostics: new Map(),
			symbolDeclarations: new Map(),
			symbolReferences: new Map(),
			hovers: new Map(),
			locations: new Map(),
			sets: new Map()
		};

		this.indices = {
			documents: new Map()
		};

		this.out = {
			all: new Map(),
			contains: new Map(),
			definition: new Map(),
			hover: new Map(),
			reference: new Map(),
			item: new Map(),
			set: new Map()
		};

		this.in = {
			all: new Map(),
			contains: new Map(),
			definition: new Map(),
			hover: new Map()
		}
	}

	public load(): void {
		let json: (Vertex | Edge)[] = JSON.parse(fs.readFileSync(this.file, 'utf8'));
		for (let item of json) {
			switch (item._type) {
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
		this.vertices.all.set(vertex._id, vertex);
		switch(vertex._kind) {
			case 'project':
				this.vertices.projects.set(vertex._id, vertex);
				break;
			case 'document':
				this.vertices.documents.set(vertex._id, vertex);
				this.indices.documents.set(vscode.Uri.parse(vertex.uri).fsPath, vertex);
				break;
			case 'diagnostic':
				this.vertices.diagnostics.set(vertex._id, vertex);
				break;
			case 'symbolDeclaration':
				this.vertices.symbolDeclarations.set(vertex._id, vertex);
				break;
			case 'symbolReference':
				this.vertices.symbolReferences.set(vertex._id, vertex);
				break;
			case 'set':
				this.vertices.sets.set(vertex._id, vertex);
				break;
			case 'hover':
				this.vertices.hovers.set(vertex._id, vertex);
				break;
			case 'location':
				this.vertices.locations.set(vertex._id, vertex);
				break;
		}
	}

	private processEdge(edge: Edge): void {
		switch (edge._kind) {
			case 'item':
				this.storeEdge(this.out.item, undefined, edge);
				break;
			case 'set':
				this.storeEdge(this.out.set, undefined, edge);
				break;
			case 'contains':
				this.storeEdge(this.out.contains, this.in.contains, edge);
				break;
			case 'textDocument/definition':
				this.storeEdge(this.out.definition, this.in.definition, edge);
				break;
			case 'textDocument/hover':
				this.storeEdge(this.out.hover, this.in.hover, edge);
				break;
			case 'textDocument/references':
				this.storeEdge(this.out.reference, undefined, edge);
				break;
		}
	}

	private storeEdge(outMap: Map<Id, Vertex[]> | undefined, inMap: Map<Id, Vertex[]> | undefined, edge: Edge): void {
		const storeMap  = (map: Map<Id, Vertex[]>, edgeId: Id, vertexId: Id): void => {
			let vertex = this.vertices.all.get(vertexId);
			if (vertex === void 0) {
				throw new Error(`Couldn't resolve vertex for Id ${vertexId}`);
			}
			let value = map.get(edgeId);
			if (value === void 0) {
				value = [];
				map.set(edgeId, value);
			}
			value.push(vertex);
		}
		storeMap(this.out.all, edge.source, edge.target);
		storeMap(this.in.all, edge.target, edge.source);
		if (outMap) {
			storeMap(outMap, edge.source, edge.target);
		}
		if (inMap) {
			storeMap(inMap, edge.target, edge.source);
		}
	}

	public findVertex(file: string, position: vscode.Position): SymbolDeclaration | SymbolReference | Location | undefined {
		let document = this.indices.documents.get(file);
		if (document === void 0) {
			return undefined;
		}
		let contains = this.out.contains.get(document._id);
		if (contains === void 0 || contains.length === 0) {
			return undefined;
		}

		let candidate: SymbolDeclaration | SymbolReference | Location | undefined;
		for (let item of contains) {
			if (item._kind === 'document') {
				continue;
			}
			let range = item.range;
			if (SipDatabase.containsPosition(range, position)) {
				if (!candidate) {
					candidate = item;
				} else {
					if (SipDatabase.containsRange(candidate.range, range)) {
						candidate = item;
					}
				}
			}
		}
		return candidate;
	}

	public containedIn(vertex: SymbolDeclaration | SymbolReference | Location | undefined): Document | undefined {
		if (vertex === void 0) {
			return void 0;
		}
		let result = this.in.contains.get(vertex._id);
		if (result === void 0 || result.length !== 1) {
			return undefined;
		}
		let item = result[0];
		return item._kind === 'document' ? item : undefined;
	}

	public definitions(vertex: SymbolReference | Location | undefined): SymbolDeclaration[] | undefined {
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
			let vertex = database.findVertex(document.uri.fsPath, position);
			if (vertex === void 0) {
				return undefined;
			}
			if (vertex._kind === 'symbolDeclaration') {
				return makeLocation(vertex);
			}
			let definitions = database.definitions(vertex);
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
			let vertex = database.findVertex(document.uri.fsPath, position);
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
			let vertex = database.findVertex(document.uri.fsPath, positions);
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