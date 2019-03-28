/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as lsp from 'vscode-languageserver';

import { Range, Id } from './protocol';
import { FileType, FileStat } from './files';

export interface UriTransformer {
	toDatabase(uri: string): string;
	fromDatabase(uri: string): string;
}

export const noopTransformer: UriTransformer = {
	toDatabase: uri => uri,
	fromDatabase: uri => uri
}

export abstract class Database {

	protected constructor() {
	}

	public getProjectRoot(): string {
		return 'file:///c:/Users/dirkb/Projects/mseng/LanguageServer/Node/jsonrpc'
	}

	public abstract load(): void;

	public abstract close(): void;

	public abstract foldingRanges(uri: string): lsp.FoldingRange[] | undefined;

	public abstract documentSymbols(uri: string): lsp.DocumentSymbol[] | undefined;

	public abstract definitions(uri: string, position: lsp.Position): lsp.Location | lsp.Location[] | undefined;

	public abstract hover(uri: string, position: lsp.Position): lsp.Hover | undefined;

	public abstract references(uri: string, position: lsp.Position, context: lsp.ReferenceContext): lsp.Location[] | undefined;

	public abstract stat(uri: string): FileStat | null;

	public abstract readDirectory(uri: string): [string, FileType][];

	public abstract readFileContent(uri: string): string;

	protected asDocumentSymbol(range: Range): lsp.DocumentSymbol | undefined {
		let tag = range.tag;
		if (tag === undefined || !(tag.type === 'declaration' || tag.type === 'definition')) {
			return undefined;
		}
		return lsp.DocumentSymbol.create(
			tag.text, tag.detail || '', tag.kind,
			tag.fullRange, this.asRange(range)
		)
	}

	protected asRange(value: Range): lsp.Range {
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
}
