/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as lsp from 'vscode-languageserver-protocol';

export type Id = number | string;

export interface Element {
	_id: Id;
	_type: 'vertex' | 'edge';
}

export type VertexLiterals = 'project' | 'document' | 'symbolDeclaration' | 'symbolReference'| 'location' | 'hover' | 'diagnostic' | 'set';

export interface V extends Element {
	_id: Id;
	_type: 'vertex';
	_kind: VertexLiterals;
}

export interface Project extends V {
	_kind: 'project',
	projectFile: string;
	contents?: string;
}

export interface Document extends V {
	_kind: 'document';
	uri: string;
	contents?: string;
}

export interface Location extends V {
	_kind: 'location';
	range: lsp.Range;
}

export interface SymbolDeclaration extends V {
	_kind: 'symbolDeclaration';

	name: string;
	detail?: string;
	kind: lsp.SymbolKind;
	deprecated?: boolean;
	range: lsp.Range;
	selectionRange: lsp.Range;
}

export interface SymbolReference extends V {
	_kind: 'symbolReference';
	name: string;
	range: lsp.Range;
}

export interface Hover extends V, lsp.Hover {
	_kind: 'hover';
}

export interface Diagnostic extends lsp.Diagnostic, V {
	_kind: 'diagnostic';
}

export interface ResultSet<R extends string, S extends V = V, T extends V = V> extends V {
	/* The brand */
	_?: [T, S];
	_kind: 'set';
	request: R;
}

export interface ReferenceSet extends ResultSet<'textDocument/references', LocationLike | ReferenceSet, LocationLike | ReferenceSet> {
}

export type LocationLike = SymbolDeclaration | SymbolReference | Location;
export type Vertex = Project | Document | LocationLike | Hover | Diagnostic | ResultSet<any> | ReferenceSet;


export type EdgeLiterals = 'contains' | 'diagnostic' | 'child' | 'item' | 'set' | 'textDocument/hover' | 'textDocument/definition' | 'textDocument/references';

export interface E<S extends V, T extends V> extends Element {
	/* The brand */
	_?: [T, S];
	_id: Id;
	_type: 'edge';
	_kind: EdgeLiterals;
	source: Id;
	target: Id;
}

export interface contains extends E<Project | Document, Document | LocationLike> {
	_kind: 'contains'
}

export interface child extends E<Document | SymbolDeclaration, SymbolDeclaration> {
	_kind: 'child';
}

export interface item extends E<ResultSet<any>, LocationLike> {
	_kind: 'item';
}

export interface set<T extends string> extends E<ResultSet<T>, ResultSet<T>> {
	_kind: 'set';
}

export interface diagnostic extends E<Project | Document, Diagnostic> {
	_kind: 'diagnostic';
}

export interface hover extends E<LocationLike, Hover> {
	_kind: 'textDocument/hover';
}

export interface definition extends E<Location | SymbolReference, SymbolDeclaration> {
	_kind: 'textDocument/definition';
}

export interface references extends E<LocationLike, LocationLike | ReferenceSet> {
	_kind: 'textDocument/references';
}

export type Edge = contains | diagnostic | child |  item | set<any> | hover | definition | references;
