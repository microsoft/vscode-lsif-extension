/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as fs from 'fs';

import URI from 'vscode-uri';

import * as lsp from 'vscode-languageserver';

import { Id, Vertex, Project, Document, Range, DiagnosticResult, DocumentSymbolResult, FoldingRangeResult, DocumentLinkResult, DefinitionResult, TypeDefinitionResult, HoverResult, ReferenceResult, ImplementationResult, Edge, RangeBasedDocumentSymbol, DeclarationResult, ResultSet } from './protocol';

interface Vertices {
	all: Map<Id, Vertex>;
	projects: Map<Id, Project>;
	documents: Map<Id, Document>;
	ranges: Map<Id, Range>;
}

type PositionUpdater = (position: lsp.Position) => lsp.Position | null;
type ItemTarget = { type: 'declaration'; range: Range } | { type: 'definition'; range: Range } | { type: 'reference'; range: Range } | { type: 'referenceResult'; result: ReferenceResult };

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

export class LsifDatabase {

	private version: string | undefined;
	private vertices: Vertices;
	private indices: Indices;
	private out: Out;
	private in: In;

	// Used to convert incoming positions into positions in the unedited document
	private newToOld : PositionUpdater = function(s){return s;};
	// Used to convert outgoing positions into positions in the edited document
	private oldToNew : PositionUpdater  = function(s){return s;};


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
				case 'vertex':
					this.processVertex(item);
					break;
				case 'edge':
					this.processEdge(item);
					break;
			}
		}
		if (this.version && this.version !== '0.1.0') {
			throw new Error(`Unsupported version  ${this.version}`);
		}
	}

	private processVertex(vertex: Vertex): void {
		this.vertices.all.set(vertex.id, vertex);
		switch(vertex.label) {
			case 'metaData':
				this.version = vertex.version;
				break;
			case 'project':
				this.vertices.projects.set(vertex.id, vertex);
				break;
			case 'document':
				this.vertices.documents.set(vertex.id, vertex);
				this.indices.documents.set(vertex.uri, vertex);
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
					case 'definition':
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
			case 'refersTo':
				this.out.refersTo.set(from.id, to as ResultSet);
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
				this.pushIfValidLocation(result, this.asLocation(element));
			}
			return result;
		} else {
			let res = this.oldLocToNewLoc(this.asLocation(definitionResult.result));
			if (res == null){
				return undefined;
			} else {
				return res;
			}
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

	public updateLocations(uri : string, changes : lsp.TextDocumentContentChangeEvent[]) {
		let new_update_forwards = function(p: lsp.Position | null){
			return (changes.reduce(LsifDatabase.updatePosition("forward"), p))};

		let new_update_backwards = function(p: lsp.Position | null){
			return (changes.reduce(LsifDatabase.updatePosition("backwards"), p))};

		let prev_newToOld = this.newToOld;

		this.newToOld = function(p: lsp.Position){ let new_pos = new_update_forwards(p);
										  if (new_pos == null){
											  return null;
										  } else {
											  return prev_newToOld(new_pos);
										  }};

		let prev_oldToNew = this.oldToNew;

		this.oldToNew = function(p: lsp.Position){ let new_pos = prev_oldToNew(p);
						  if (new_pos == null){
							  return null;
						  } else {
							  return new_update_backwards(new_pos);
						  }};
		return null;
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
	// Convert an old location to a new location and push the result if its still valid.
	private pushIfValidLocation(array : lsp.Location[], old_loc : lsp.Location) {
		let new_loc = this.oldLocToNewLoc(old_loc);
		if (new_loc != null){
			array.push(new_loc);
		}
	}

	private oldLocToNewLoc (old_loc : lsp.Location) : lsp.Location | null {
		let new_start = this.oldToNew(old_loc.range.start);
		let new_end   = this.oldToNew(old_loc.range.end);
		if (new_start == null || new_end == null){
			return null;
		} else {
			return (lsp.Location.create(old_loc.uri, { start : new_start, end : new_end }));
		}
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
						case 'reference':
							references.push(target.range);
							break;
						case 'declaration':
							declarations.push(target.range);
						case 'definition':
							definitions.push(target.range);
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
			let loc = lsp.Location.create((document as Document).uri, this.asRange(value));
			this.pushIfValidLocation(result, loc);
			result.push();
			dedup.add(value.id);
		}
	}

	private findRangeFromPosition(file: string, position_new: lsp.Position): Range | undefined {
		let position = this.newToOld(position_new);
		if (position == null){
			return undefined;
		}
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
			if (LsifDatabase.containsPosition(range, position)) {
				if (!candidate) {
					candidate = item;
				} else {
					if (LsifDatabase.containsRange(candidate, range)) {
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

	private asRange(value: Range): lsp.Range {
		return {
			start: {
				line: value.start.line,
				character: value.start.character
			},
			end: {
				line: value.end.line,
				character: value.end.character
			}
		};
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
	// This function tries to map positions in the database to new positions in an edited document.
	// It was implemented in Haskell by Zubin Duggal and Luke Lau.
	// https://github.com/haskell/haskell-ide-engine/blob/master/src/Haskell/Ide/Engine/Transport/LspStdio.hs#L268
	private static updatePosition (dir: String) : (p : lsp.Position | null, ce : lsp.TextDocumentContentChangeEvent) => lsp.Position | null {
		return function update_position(p : lsp.Position | null, ce : lsp.TextDocumentContentChangeEvent) : lsp.Position | null {

		if (p == null){
			return null;
		}
		// Pattern matching on the arguments
		let l = p.line;
		let c = p.character;

		let sl = ce.range!.start.line;
		let sc = ce.range!.start.character;

		let el = ce.range!.end.line;
		let ec = ce.range!.end.character;

		// Where clause
		let txt = ce.text;
		let oldL = el - sl;
		let lines = txt.split("\n");
		let newL = lines.length - 1;
		let nec = (newL == 0 ) ? sc + txt.length : lines[lines.length - 1].length;

		let plusMinus = function (x : number, y : number) { return (dir == "forward" ? x - y : x + y); };

		let dl = newL - oldL;
		let l1 = plusMinus(l, dl);

		// pos is before the change - unaffected
		if (l < sl) { return p; };
		//  pos is somewhere after the changed line,
		//  move down the pos to keep it the same
		if (l > el) { p.line = l1;
					  return p; };
		//
		//	LEGEND:
		//	0-9   char index
		//	x     untouched char
		//	I/i   inserted/replaced char
		//	.     deleted char
		//	^     pos to be converted
		//
		//
		//
		//	012345  67
		//	xxxxxx  xx
		//	 ^
		//	0123456789
		//	xxIIIIiixx
		//	 ^
		//	pos is unchanged if before the edited range

		if (l == sl && c <= sc) {
			return p; };

		//	01234  56
		//  xxxxx  xx
		//	  ^
		//	012345678
		//	xxIIIiixx
		//		   ^
		//	If pos is in the affected range move to after the range
		if (l == sl && l == el && c <= nec && newL == 0)
			{ p.character = ec;
			  return p; };
		//
		//	01234  56
		//	xxxxx  xx
		//		   ^
		//	012345678
		//	xxIIIiixx
		//		   ^
		//	If pos is after the affected range, update the char index
		//	to keep it in the same place
		if (l == sl && l == el && c > nec && newL == 0)
			{ p.character = plusMinus (c, (nec - sc));
			  return p;}
		// Oh well, we tried but we can't work out where the range came from.
		return null;
	}}
}